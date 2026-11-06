//! `myso-mls`: the one MLS (RFC 9420) implementation shared by the relayer (native), the web app and
//! Node agents (WASM) and iOS (UniFFI). Wraps OpenMLS behind a narrow, bytes-in / bytes-out API so
//! every platform runs identical protocol code. See docs/myso-messaging-stack/E2EE-Roadmap.md (M3+).
//!
//! Messages are double-wrapped: the content-envelope-v2 plaintext is first sealed with the MyData DEK
//! (on-chain `MessagingReader` gate), then that ciphertext is sent as an MLS application message
//! (per-message keys, forward secrecy, post-compromise security).

pub mod certificate;
pub mod history;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;

#[cfg(not(target_arch = "wasm32"))]
uniffi::setup_scaffolding!();

pub use certificate::DeviceCertificate;

use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

/// X25519 + AES-128-GCM + SHA-256 + Ed25519: available in CryptoKit, WebCrypto-free in WASM.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

#[derive(Debug, thiserror::Error)]
pub enum MlsError {
    #[error("mls: {0}")]
    Protocol(String),
    #[error("mls codec: {0}")]
    Codec(String),
    #[error("mls: unexpected message type")]
    UnexpectedMessage,
}

pub type Result<T> = std::result::Result<T, MlsError>;

fn proto<E: std::fmt::Debug>(e: E) -> MlsError {
    MlsError::Protocol(format!("{e:?}"))
}

fn codec<E: std::fmt::Debug>(e: E) -> MlsError {
    MlsError::Codec(format!("{e:?}"))
}

/// One device's MLS identity: its own signature key + credential (identity bytes = wallet-certified
/// device id from M4) and the OpenMLS key store.
pub struct Device {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

/// Result of processing an inbound MLS message.
#[derive(Debug, PartialEq, Eq)]
pub enum Processed {
    /// Application message (the inner DEK-sealed envelope ciphertext) and its sender's identity.
    Application { plaintext: Vec<u8>, sender_identity: Vec<u8> },
    /// A commit was applied; the group is now at this epoch.
    Commit { epoch: u64 },
    /// Proposal stored for a later commit.
    Proposal,
    /// This device's own commit / message echoed back by the relayer (already applied locally).
    Own,
}

/// A device's MLS signature key, generated before its certificate exists (the certificate signs
/// over the public key) and persisted by the platform.
pub struct DeviceKeys {
    signer: SignatureKeyPair,
}

impl DeviceKeys {
    pub fn generate() -> Result<Self> {
        Ok(Self { signer: SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(proto)? })
    }

    pub fn public_key(&self) -> Vec<u8> {
        self.signer.to_public_vec()
    }

    /// Opaque secret bytes for platform secure storage (Keychain / sealed IndexedDB).
    pub fn to_secret_bytes(&self) -> Result<Vec<u8>> {
        self.signer.tls_serialize_detached().map_err(codec)
    }

    pub fn from_secret_bytes(bytes: &[u8]) -> Result<Self> {
        Ok(Self { signer: SignatureKeyPair::tls_deserialize_exact(bytes).map_err(codec)? })
    }

    /// Raw ed25519 signature over `message`. Used for a device's *authority key* (v2 certificates
    /// and nothing else); the same type holds it because it is the same kind of key.
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
        openmls_traits::signatures::Signer::sign(&self.signer, message).map_err(proto)
    }
}

/// One group member as seen in the ratchet tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberInfo {
    pub leaf_index: u32,
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
}

impl MemberInfo {
    /// The wallet-signed certificate, when the identity is one and it names this leaf's key.
    pub fn certificate(&self) -> Option<DeviceCertificate> {
        DeviceCertificate::from_identity(&self.identity).filter(|c| c.names_key(&self.signature_key))
    }
}

impl Device {
    /// Bind persisted keys to an identity (a serialized [`DeviceCertificate`] in production).
    pub fn from_keys(keys: DeviceKeys, identity: &[u8]) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        keys.signer.store(provider.storage()).map_err(proto)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: keys.signer.public().into(),
        };
        Ok(Self { provider, signer: keys.signer, credential })
    }

    /// Full device state for platform storage: signer, identity and every group's MLS state
    /// (OpenMLS writes group state to the provider store on each operation). Persist after every
    /// mutating call; restore on launch. Treat as secret (seal at rest).
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let signer = self.signer.tls_serialize_detached().map_err(codec)?;
        let identity = self.credential.credential.serialized_content().to_vec();
        let values = self.provider.storage().values.read().map_err(|_| MlsError::Codec("storage poisoned".into()))?;
        let mut out = Vec::new();
        out.extend_from_slice(b"MYSOMLS1");
        for part in [&signer, &identity] {
            out.extend_from_slice(&(part.len() as u32).to_be_bytes());
            out.extend_from_slice(part);
        }
        out.extend_from_slice(&(values.len() as u64).to_be_bytes());
        for (k, v) in values.iter() {
            out.extend_from_slice(&(k.len() as u32).to_be_bytes());
            out.extend_from_slice(&(v.len() as u32).to_be_bytes());
            out.extend_from_slice(k);
            out.extend_from_slice(v);
        }
        Ok(out)
    }

    pub fn restore(bytes: &[u8]) -> Result<Self> {
        let bad = || MlsError::Codec("bad device snapshot".into());
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8]> {
            let end = at.checked_add(n).filter(|e| *e <= bytes.len()).ok_or_else(bad)?;
            let s = &bytes[at..end];
            at = end;
            Ok(s)
        };
        if take(8)? != b"MYSOMLS1" {
            return Err(bad());
        }
        let u32_at = |s: &[u8]| u32::from_be_bytes(s.try_into().unwrap()) as usize;
        let n = u32_at(take(4)?);
        let signer = SignatureKeyPair::tls_deserialize_exact(take(n)?).map_err(codec)?;
        let n = u32_at(take(4)?);
        let identity = take(n)?.to_vec();
        let count = u64::from_be_bytes(take(8)?.try_into().unwrap()) as usize;
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider.storage().values.write().map_err(|_| bad())?;
            for _ in 0..count {
                let k_len = u32_at(take(4)?);
                let v_len = u32_at(take(4)?);
                let k = take(k_len)?.to_vec();
                let v = take(v_len)?.to_vec();
                values.insert(k, v);
            }
        }
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self { provider, signer, credential })
    }

    /// A group this device already belongs to, from restored state.
    pub fn load_group(&self, group_id: &[u8]) -> Result<Option<Group>> {
        Ok(MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(proto)?
            .map(|inner| Group { inner }))
    }

    pub fn identity(&self) -> Vec<u8> {
        self.credential.credential.serialized_content().to_vec()
    }

    /// A copy of this device carrying `identity` (a renewed certificate); see [`Device::set_identity`].
    /// Bindings use this so their device handles stay immutable: callers swap to the returned
    /// device and reload their groups from it.
    pub fn with_identity(&self, identity: &[u8]) -> Result<Device> {
        let mut renewed = Device::restore(&self.snapshot()?)?;
        renewed.set_identity(identity)?;
        Ok(renewed)
    }

    /// Replace this device's credential identity (a renewed certificate). The MLS signature key is
    /// unchanged, so the certificate must name it. New KeyPackages / groups use it at once;
    /// existing groups learn it from [`Group::update_credential`] commits.
    pub fn set_identity(&mut self, identity: &[u8]) -> Result<()> {
        let cert = DeviceCertificate::from_identity(identity).ok_or(MlsError::UnexpectedMessage)?;
        if !cert.names_key(self.signer.public()) {
            return Err(MlsError::UnexpectedMessage);
        }
        self.credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: self.signer.public().into(),
        };
        Ok(())
    }

    pub fn new(identity: &[u8]) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(proto)?;
        signer.store(provider.storage()).map_err(proto)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self { provider, signer, credential })
    }

    /// A fresh KeyPackage (what others need to add this device), TLS-serialized as an MlsMessage.
    pub fn key_package(&self) -> Result<Vec<u8>> {
        let bundle = KeyPackage::builder()
            .build(CIPHERSUITE, &self.provider, &self.signer, self.credential.clone())
            .map_err(proto)?;
        MlsMessageOut::from(bundle.key_package().clone())
            .tls_serialize_detached()
            .map_err(codec)
    }

    fn group_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            // Ratchet tree travels in the Welcome, so joiners need no separate tree fetch.
            .use_ratchet_tree_extension(true)
            // Tolerate late messages from a few past epochs (offline catch-up).
            .max_past_epochs(5)
            .build()
    }

    /// Join config for every non-creator path: same tree-in-Welcome + past-epoch policy as the
    /// creator, so Welcomes produced by any member carry the ratchet tree.
    fn join_config() -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(5)
            .build()
    }

    pub fn create_group(&self, group_id: &[u8]) -> Result<Group> {
        let inner = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &Self::group_config(),
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map_err(proto)?;
        Ok(Group { inner })
    }

    /// Join an existing group on our own (new device of an existing member, M5) from a GroupInfo
    /// the relayer serves to on-chain members. Returns the group and the external commit to post
    /// as a `commit` row; existing members then verify our certificate like any other add.
    pub fn join_external(&self, group_info: &[u8]) -> Result<(Group, Vec<u8>)> {
        let message = MlsMessageIn::tls_deserialize_exact(group_info).map_err(codec)?;
        let MlsMessageBodyIn::GroupInfo(info) = message.extract() else {
            return Err(MlsError::UnexpectedMessage);
        };
        let join = Self::join_config();
        let (mut inner, bundle) = MlsGroup::external_commit_builder()
            .with_config(join)
            .build_group(&self.provider, info, self.credential.clone())
            .map_err(proto)?
            .load_psks(self.provider.storage())
            .map_err(proto)?
            .build(self.provider.rand(), self.provider.crypto(), &self.signer, |_| true)
            .map_err(proto)?
            .finalize(&self.provider)
            .map_err(proto)?;
        inner.merge_pending_commit(&self.provider).map_err(proto)?;
        let (commit, _, _) = bundle.into_contents();
        Ok((Group { inner }, commit.tls_serialize_detached().map_err(codec)?))
    }

    /// Resync (E2EE M6 hardening): drop this device's local state for the group and rejoin it by
    /// external commit. Used when the device fell out of step with the relayer log (a commit it
    /// can't apply, a gap, or a removal while still authorized). OpenMLS puts a Remove of our old
    /// leaf (same signature key) into the external commit, so peers never see a duplicate leaf.
    /// Callers snapshot first: if the commit loses the epoch race, restore and retry.
    pub fn rejoin_external(&self, group_info: &[u8]) -> Result<(Group, Vec<u8>)> {
        let message = MlsMessageIn::tls_deserialize_exact(group_info).map_err(codec)?;
        let MlsMessageBodyIn::GroupInfo(info) = message.extract() else {
            return Err(MlsError::UnexpectedMessage);
        };
        if let Some(mut old) = MlsGroup::load(self.provider.storage(), info.group_id()).map_err(proto)? {
            old.delete(self.provider.storage()).map_err(proto)?;
        }
        self.join_external(group_info)
    }

    /// Forget a group locally (after leaving it, or when its MLS state is unrecoverable).
    pub fn delete_group(&self, group_id: &[u8]) -> Result<()> {
        if let Some(mut old) = MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id)).map_err(proto)? {
            old.delete(self.provider.storage()).map_err(proto)?;
        }
        Ok(())
    }

    /// Join from a Welcome produced by another member's `add_members`.
    pub fn join(&self, welcome: &[u8]) -> Result<Group> {
        let message = MlsMessageIn::tls_deserialize_exact(welcome).map_err(codec)?;
        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
            return Err(MlsError::UnexpectedMessage);
        };
        let join = Self::join_config();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &join, welcome, None)
            .map_err(proto)?;
        Ok(Group { inner: staged.into_group(&self.provider).map_err(proto)? })
    }
}

pub struct Group {
    inner: MlsGroup,
}

impl Group {
    pub fn epoch(&self) -> u64 {
        self.inner.epoch().as_u64()
    }

    pub fn member_count(&self) -> usize {
        self.inner.members().count()
    }

    pub fn members(&self) -> Vec<MemberInfo> {
        self.inner
            .members()
            .map(|m| MemberInfo {
                leaf_index: m.index.u32(),
                identity: m.credential.serialized_content().to_vec(),
                signature_key: m.signature_key,
            })
            .collect()
    }

    /// Leaves that fail `authorized` (e.g. wallet lacks on-chain MessagingReader, or the
    /// certificate doesn't verify). Clients must remove these before encrypting anything.
    pub fn unauthorized_leaves(&self, authorized: impl Fn(&MemberInfo) -> bool) -> Vec<u32> {
        self.members().into_iter().filter(|m| !authorized(m)).map(|m| m.leaf_index).collect()
    }

    /// Remove leaves (unauthorized devices, removed members, logged-out devices). Returns the commit.
    pub fn remove_leaves(&mut self, device: &Device, leaves: &[u32]) -> Result<Vec<u8>> {
        let indices: Vec<LeafNodeIndex> = leaves.iter().map(|i| LeafNodeIndex::new(*i)).collect();
        let (commit, _welcome, _info) = self
            .inner
            .remove_members(&device.provider, &device.signer, &indices)
            .map_err(proto)?;
        self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
        commit.tls_serialize_detached().map_err(codec)
    }

    /// Signed GroupInfo (with ratchet tree) for external joins. Republish after every commit.
    pub fn group_info(&self, device: &Device) -> Result<Vec<u8>> {
        self.inner
            .export_group_info(device.provider.crypto(), &device.signer, true)
            .map_err(proto)?
            .tls_serialize_detached()
            .map_err(codec)
    }

    /// Logout: propose removing this device. Another member commits it (`commit_pending`).
    pub fn leave(&mut self, device: &Device) -> Result<Vec<u8>> {
        self.inner
            .leave_group(&device.provider, &device.signer)
            .map_err(proto)?
            .tls_serialize_detached()
            .map_err(codec)
    }

    /// Commit stored proposals (e.g. another device's self-removal). `None` when there are none.
    pub fn commit_pending(&mut self, device: &Device) -> Result<Option<Vec<u8>>> {
        if self.inner.pending_proposals().next().is_none() {
            return Ok(None);
        }
        let (commit, _welcome, _info) = self
            .inner
            .commit_to_pending_proposals(&device.provider, &device.signer)
            .map_err(proto)?;
        self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
        Ok(Some(commit.tls_serialize_detached().map_err(codec)?))
    }

    /// Whether this device is still in the group (false after another member removed it).
    pub fn is_active(&self) -> bool {
        self.inner.is_active()
    }

    /// Add devices by KeyPackage. Returns `(commit, welcome)`: the commit goes to existing members
    /// through the relayer, the welcome to the new devices. Applied locally right away.
    pub fn add_members(&mut self, device: &Device, key_packages: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut packages = Vec::with_capacity(key_packages.len());
        for bytes in key_packages {
            let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(codec)?;
            let MlsMessageBodyIn::KeyPackage(kp) = message.extract() else {
                return Err(MlsError::UnexpectedMessage);
            };
            packages.push(
                kp.validate(device.provider.crypto(), ProtocolVersion::Mls10)
                    .map_err(proto)?,
            );
        }
        let (commit, welcome, _info) = self
            .inner
            .add_members(&device.provider, &device.signer, &packages)
            .map_err(proto)?;
        self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
        Ok((
            commit.tls_serialize_detached().map_err(codec)?,
            welcome.tls_serialize_detached().map_err(codec)?,
        ))
    }

    /// Rotate this device's leaf (post-compromise security). Returns the commit to broadcast.
    /// Commit this device's current credential (after [`Device::set_identity`]) into the group:
    /// a self-update whose leaf carries the renewed certificate. Returns the commit.
    pub fn update_credential(&mut self, device: &Device) -> Result<Vec<u8>> {
        let params = LeafNodeParameters::builder()
            .with_credential_with_key(device.credential.clone())
            .build();
        let bundle = self
            .inner
            .self_update(&device.provider, &device.signer, params)
            .map_err(proto)?;
        self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
        bundle.into_commit().tls_serialize_detached().map_err(codec)
    }

    pub fn self_update(&mut self, device: &Device) -> Result<Vec<u8>> {
        let bundle = self
            .inner
            .self_update(&device.provider, &device.signer, LeafNodeParameters::default())
            .map_err(proto)?;
        self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
        bundle.into_commit().tls_serialize_detached().map_err(codec)
    }

    /// Seal an application message (the inner DEK ciphertext) for the group.
    pub fn encrypt(&mut self, device: &Device, plaintext: &[u8]) -> Result<Vec<u8>> {
        self.inner
            .create_message(&device.provider, &device.signer, plaintext)
            .map_err(proto)?
            .tls_serialize_detached()
            .map_err(codec)
    }

    /// Process one relayer-ordered MLS message (application, commit or proposal).
    pub fn process(&mut self, device: &Device, bytes: &[u8]) -> Result<Processed> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(codec)?;
        let protocol = message.try_into_protocol_message().map_err(proto)?;
        let processed = self.inner.process_message(&device.provider, protocol).map_err(proto)?;
        let sender_identity = processed.credential().serialized_content().to_vec();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => Ok(Processed::Application {
                plaintext: app.into_bytes(),
                sender_identity,
            }),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                self.inner
                    .merge_staged_commit(&device.provider, *staged)
                    .map_err(proto)?;
                Ok(Processed::Commit { epoch: self.epoch() })
            }
            ProcessedMessageContent::ProposalMessage(p) => {
                self.inner
                    .store_pending_proposal(device.provider.storage(), *p)
                    .map_err(proto)?;
                Ok(Processed::Proposal)
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => Ok(Processed::Proposal),
            // Our own commit fanned back while still pending in storage (e.g. state restored from
            // a snapshot taken between staging and merging): the relayer accepted it, so merge it.
            // Treating it as an echo would leave this device an epoch behind the group.
            ProcessedMessageContent::OwnPendingCommit => {
                self.inner.merge_pending_commit(&device.provider).map_err(proto)?;
                Ok(Processed::Commit { epoch: self.epoch() })
            }
            #[allow(unreachable_patterns)]
            // Includes `OwnPrivateMessage`: our own encrypted message / commit fanned back. We
            // can't decrypt it; if it's a commit at our current epoch we never applied it (state
            // rolled back after the relayer accepted it) and the caller must resync.
            _ => Ok(Processed::Own),
        }
    }

    /// Epoch-bound secret (RFC 9420 exporter) — lets the DEK layer bind to the MLS epoch if wanted.
    pub fn export_secret(&self, device: &Device, label: &str, len: usize) -> Result<Vec<u8>> {
        self.inner
            .export_secret(device.provider.crypto(), label, &[], len)
            .map_err(proto)
    }
}

/// What the relayer can see in an MLS message without any keys (RFC 9420 framing is cleartext).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageInfo {
    Application { group_id: Vec<u8>, epoch: u64 },
    Commit { group_id: Vec<u8>, epoch: u64 },
    Proposal { group_id: Vec<u8>, epoch: u64 },
    Welcome,
    KeyPackage,
    /// Published for external joins; the relayer serves the latest one per group.
    GroupInfo { group_id: Vec<u8>, epoch: u64 },
    Other,
}

/// Classify an MLS message by its cleartext header (relayer: one commit per epoch, routing).
pub fn inspect(bytes: &[u8]) -> Result<MessageInfo> {
    let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(codec)?;
    let body = message.extract();
    let protocol: ProtocolMessage = match body {
        MlsMessageBodyIn::Welcome(_) => return Ok(MessageInfo::Welcome),
        MlsMessageBodyIn::KeyPackage(_) => return Ok(MessageInfo::KeyPackage),
        MlsMessageBodyIn::GroupInfo(info) => {
            return Ok(MessageInfo::GroupInfo {
                group_id: info.group_id().as_slice().to_vec(),
                epoch: info.epoch().as_u64(),
            })
        }
        MlsMessageBodyIn::PublicMessage(m) => m.into(),
        MlsMessageBodyIn::PrivateMessage(m) => m.into(),
    };
    let group_id = protocol.group_id().as_slice().to_vec();
    let epoch = protocol.epoch().as_u64();
    Ok(match protocol.content_type() {
        ContentType::Application => MessageInfo::Application { group_id, epoch },
        ContentType::Commit => MessageInfo::Commit { group_id, epoch },
        ContentType::Proposal => MessageInfo::Proposal { group_id, epoch },
    })
}

/// Credential identity + signature key inside a KeyPackage (relayer validates uploads).
pub fn key_package_member(bytes: &[u8]) -> Result<MemberInfo> {
    let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(codec)?;
    let MlsMessageBodyIn::KeyPackage(kp) = message.extract() else {
        return Err(MlsError::UnexpectedMessage);
    };
    let kp = kp
        .validate(OpenMlsRustCrypto::default().crypto(), ProtocolVersion::Mls10)
        .map_err(proto)?;
    let leaf = kp.leaf_node();
    Ok(MemberInfo {
        leaf_index: 0,
        identity: leaf.credential().serialized_content().to_vec(),
        signature_key: leaf.signature_key().as_slice().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn two_devices_exchange_messages_and_ratchet() {
        let alice = Device::new(b"alice-device").unwrap();
        let bob = Device::new(b"bob-device").unwrap();
        let mut ag = alice.create_group(b"group-1").unwrap();
        let (_commit, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();
        assert_eq!(ag.epoch(), bg.epoch());

        let ct = ag.encrypt(&alice, b"dek-sealed envelope").unwrap();
        assert_eq!(
            bg.process(&bob, &ct).unwrap(),
            Processed::Application { plaintext: b"dek-sealed envelope".to_vec(), sender_identity: b"alice-device".to_vec() }
        );
        // Forward secrecy at the message level: the same ciphertext can't be processed twice.
        assert!(bg.process(&bob, &ct).is_err());

        // Post-compromise security: Bob rotates; Alice follows the commit.
        let commit = bg.self_update(&bob).unwrap();
        assert!(matches!(ag.process(&alice, &commit).unwrap(), Processed::Commit { .. }));
        assert_eq!(ag.epoch(), bg.epoch());
        let reply = bg.encrypt(&bob, b"after update").unwrap();
        assert!(matches!(ag.process(&alice, &reply).unwrap(), Processed::Application { .. }));
    }

    #[test]
    fn non_members_cannot_read() {
        let alice = Device::new(b"alice").unwrap();
        let eve = Device::new(b"eve").unwrap();
        let mut ag = alice.create_group(b"g").unwrap();
        let mut eg = eve.create_group(b"g").unwrap();
        let ct = ag.encrypt(&alice, b"secret").unwrap();
        assert!(eg.process(&eve, &ct).is_err());
    }

    fn certified(wallet: &str, device: &str) -> Device {
        let keys = DeviceKeys::generate().unwrap();
        let cert = DeviceCertificate {
            v: 1,
            wallet: wallet.into(),
            device_id: device.into(),
            mls_key: hex::encode(keys.public_key()),
            issued_at_ms: 1,
            sig: "00".into(),
            signer_key: "00".into(),
            authority_key: None,
        };
        Device::from_keys(keys, &cert.to_identity()).unwrap()
    }

    #[test]
    fn certificates_bind_wallet_to_leaf_key() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "laptop");
        let mut g = alice.create_group(b"g").unwrap();
        g.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let wallets: Vec<String> = g.members().iter().map(|m| m.certificate().unwrap().wallet).collect();
        assert_eq!(wallets, vec!["0xa", "0xb"]);
        // A certificate naming another key is rejected.
        let mut forged = g.members()[1].clone();
        forged.signature_key = vec![0; 32];
        assert!(forged.certificate().is_none());
    }

    #[test]
    fn unauthorized_leaves_are_removed_before_sending() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let eve = certified("0xe", "phone");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag
            .add_members(&alice, &[bob.key_package().unwrap(), eve.key_package().unwrap()])
            .unwrap();
        let mut bg = bob.join(&welcome).unwrap();
        // On-chain readers are 0xa and 0xb only.
        let readers = ["0xa", "0xb"];
        let is_reader = |m: &MemberInfo| m.certificate().is_some_and(|c| readers.contains(&c.wallet.as_str()));
        let bad = bg.unauthorized_leaves(is_reader);
        assert_eq!(bad.len(), 1);
        let commit = bg.remove_leaves(&bob, &bad).unwrap();
        ag.process(&alice, &commit).unwrap();
        assert!(ag.unauthorized_leaves(is_reader).is_empty());
        assert_eq!(ag.member_count(), 2);
    }

    #[test]
    fn relayer_can_inspect_headers_without_keys() {
        let alice = Device::new(b"a").unwrap();
        let bob = Device::new(b"b").unwrap();
        let mut g = alice.create_group(b"group-x").unwrap();
        let kp = bob.key_package().unwrap();
        assert_eq!(inspect(&kp).unwrap(), MessageInfo::KeyPackage);
        assert_eq!(key_package_member(&kp).unwrap().identity, b"b".to_vec());
        let (commit, welcome) = g.add_members(&alice, &[kp]).unwrap();
        assert_eq!(inspect(&commit).unwrap(), MessageInfo::Commit { group_id: b"group-x".to_vec(), epoch: 0 });
        assert_eq!(inspect(&welcome).unwrap(), MessageInfo::Welcome);
        let app = g.encrypt(&alice, b"x").unwrap();
        assert_eq!(inspect(&app).unwrap(), MessageInfo::Application { group_id: b"group-x".to_vec(), epoch: 1 });
    }

    #[test]
    fn device_keys_round_trip_for_persistence() {
        let keys = DeviceKeys::generate().unwrap();
        let public = keys.public_key();
        let restored = DeviceKeys::from_secret_bytes(&keys.to_secret_bytes().unwrap()).unwrap();
        assert_eq!(restored.public_key(), public);
    }

    #[test]
    fn new_device_joins_by_external_commit_and_existing_members_follow() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let bob_laptop = certified("0xb", "laptop");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();

        // Bob's new laptop joins on its own from the published GroupInfo.
        let info = ag.group_info(&alice).unwrap();
        assert_eq!(inspect(&info).unwrap(), MessageInfo::GroupInfo { group_id: b"g".to_vec(), epoch: 1 });
        let (mut lg, commit) = bob_laptop.join_external(&info).unwrap();
        assert!(matches!(inspect(&commit).unwrap(), MessageInfo::Commit { epoch: 1, .. }));
        ag.process(&alice, &commit).unwrap();
        bg.process(&bob, &commit).unwrap();
        assert_eq!(ag.member_count(), 3);
        // The laptop is certified for Bob's wallet, so the reconcile rule keeps it.
        let readers = ["0xa", "0xb"];
        assert!(ag
            .unauthorized_leaves(|m| m.certificate().is_some_and(|c| readers.contains(&c.wallet.as_str())))
            .is_empty());
        // Messages after the join reach the new device; earlier ones never could (forward secrecy).
        let ct = ag.encrypt(&alice, b"hi laptop").unwrap();
        assert!(matches!(lg.process(&bob_laptop, &ct).unwrap(), Processed::Application { .. }));
    }

    #[test]
    fn desynced_device_rejoins_without_a_duplicate_leaf() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let carol = certified("0xc", "phone");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();
        assert_eq!(bg.epoch(), 1);

        // Bob misses a commit (e.g. he rolled back a commit the relayer actually accepted).
        let (_missed, _w) = ag.add_members(&alice, &[carol.key_package().unwrap()]).unwrap();
        let ct = ag.encrypt(&alice, b"after the gap").unwrap();
        assert!(bg.process(&bob, &ct).is_err(), "a device behind the log can't read");

        // Resync from the current GroupInfo: same signature key, old leaf removed in the commit.
        let info = ag.group_info(&alice).unwrap();
        let before = ag.member_count();
        let (mut bg2, commit) = bob.rejoin_external(&info).unwrap();
        ag.process(&alice, &commit).unwrap();
        assert_eq!(ag.member_count(), before, "old leaf replaced, not duplicated");
        let bob_key = bob.credential.signature_key.as_slice().to_vec();
        assert_eq!(ag.members().iter().filter(|m| m.signature_key == bob_key).count(), 1);
        assert_eq!(bg2.epoch(), ag.epoch());

        let ct = ag.encrypt(&alice, b"welcome back").unwrap();
        match bg2.process(&bob, &ct).unwrap() {
            Processed::Application { plaintext, .. } => assert_eq!(plaintext, b"welcome back"),
            other => panic!("unexpected {other:?}"),
        }
        // Restored state sees the rejoined group, not the stale one.
        let restored = Device::restore(&bob.snapshot().unwrap()).unwrap();
        assert_eq!(restored.load_group(b"g").unwrap().unwrap().epoch(), ag.epoch());
        bob.delete_group(b"g").unwrap();
        assert!(bob.load_group(b"g").unwrap().is_none());
    }

    #[test]
    fn own_commit_after_rollback_is_detectable_and_recoverable() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let carol = certified("0xc", "phone");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let _bg = bob.join(&welcome).unwrap();
        let snap = alice.snapshot().unwrap();
        let (commit, _w) = ag.add_members(&alice, &[carol.key_package().unwrap()]).unwrap();
        // The post "failed": restore, then the relayer log shows the commit was accepted after all.
        let alice2 = Device::restore(&snap).unwrap();
        let mut ag2 = alice2.load_group(b"g").unwrap().unwrap();
        assert_eq!(ag2.epoch(), 1);
        // We can't decrypt our own commit: surfaced as `Own` at our current epoch, which tells
        // the client it never applied it and must resync (see `rejoin_external`).
        assert_eq!(ag2.process(&alice2, &commit).unwrap(), Processed::Own);
        assert_eq!(ag2.epoch(), 1);
        let info = ag.group_info(&alice).unwrap();
        let (ag3, _commit) = alice2.rejoin_external(&info).unwrap();
        assert_eq!(ag3.epoch(), 3);
    }

    #[test]
    fn v2_certificates_renew_without_the_wallet_and_reach_peers() {
        let alice = certified("0xa", "phone");
        // Bob's phone: v1 certificate now, plus a long-lived authority key (registered on-chain).
        let bob_keys = DeviceKeys::generate().unwrap();
        let bob_mls = hex::encode(bob_keys.public_key());
        let authority = DeviceKeys::generate().unwrap();
        let v1 = DeviceCertificate {
            v: 1, wallet: "0xb".into(), device_id: "phone".into(), mls_key: bob_mls.clone(),
            issued_at_ms: 1, sig: "00".into(), signer_key: "00".into(), authority_key: None,
        };
        let mut bob = Device::from_keys(bob_keys, &v1.to_identity()).unwrap();
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();

        // The device renews on its own: authority key signs, no wallet involved.
        let v2 = DeviceCertificate::issue_v2(&authority, "0xB", "phone", &bob_mls, 2).unwrap();
        assert_eq!(v2.v, 2);
        assert_eq!(v2.wallet, "0xb");
        assert!(v2.verify_authority_signature());
        assert_eq!(DeviceCertificate::from_identity(&v2.to_identity()), Some(v2.clone()));
        // Tampering with any signed field breaks it.
        for bad in [
            DeviceCertificate { mls_key: hex::encode([7u8; 32]), ..v2.clone() },
            DeviceCertificate { wallet: "0xc".into(), ..v2.clone() },
            DeviceCertificate { authority_key: Some(hex::encode(DeviceKeys::generate().unwrap().public_key())), ..v2.clone() },
        ] {
            assert!(!bad.verify_authority_signature());
        }
        assert!(!v1.verify_authority_signature(), "v1 has no authority signature");

        // A certificate for another MLS key can't be installed.
        let other = DeviceCertificate::issue_v2(&authority, "0xb", "phone", &hex::encode([9u8; 32]), 3).unwrap();
        assert!(bob.set_identity(&other.to_identity()).is_err());

        // Install and push to the group: Alice now sees Bob's v2 certificate on his leaf.
        bob.set_identity(&v2.to_identity()).unwrap();
        let commit = bg.update_credential(&bob).unwrap();
        ag.process(&alice, &commit).unwrap();
        let bob_leaf = ag.members().into_iter().find(|m| m.certificate().is_some_and(|c| c.wallet == "0xb")).unwrap();
        assert_eq!(bob_leaf.certificate().unwrap(), v2);
        // Messaging still works across the update, both ways.
        let ct = ag.encrypt(&alice, b"after renewal").unwrap();
        assert!(matches!(bg.process(&bob, &ct).unwrap(), Processed::Application { .. }));
        let ct = bg.encrypt(&bob, b"hi").unwrap();
        match ag.process(&alice, &ct).unwrap() {
            Processed::Application { sender_identity, .. } => assert_eq!(sender_identity, v2.to_identity()),
            other => panic!("{other:?}"),
        }
        // New KeyPackages carry the renewed certificate; it survives a restart.
        let kp = bob.key_package().unwrap();
        assert_eq!(key_package_member(&kp).unwrap().certificate().unwrap(), v2);
        let restored = Device::restore(&bob.snapshot().unwrap()).unwrap();
        assert_eq!(restored.identity(), v2.to_identity());
    }

    #[test]
    fn logout_removes_the_device_via_proposal_and_commit() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();
        // A joined (non-creator) member's Welcomes must carry the tree too.
        let carol = certified("0xc", "phone");
        let (c2, w2) = bg.add_members(&bob, &[carol.key_package().unwrap()]).unwrap();
        ag.process(&alice, &c2).unwrap();
        let mut cg = carol.join(&w2).expect("welcome from a joined member carries the tree");
        let proposal = bg.leave(&bob).unwrap();
        cg.process(&carol, &proposal).unwrap();
        assert_eq!(ag.process(&alice, &proposal).unwrap(), Processed::Proposal);
        let commit = ag.commit_pending(&alice).unwrap().expect("a pending removal");
        bg.process(&bob, &commit).unwrap();
        cg.process(&carol, &commit).unwrap();
        assert!(!bg.is_active());
        assert_eq!(ag.member_count(), 2);
        assert!(ag.commit_pending(&alice).unwrap().is_none());
    }

    #[test]
    fn history_bundles_round_trip_over_mls() {
        let a1 = certified("0xa", "phone");
        let a2 = certified("0xa", "laptop");
        // Self-group: just this wallet's devices.
        let mut self_group = a1.create_group(b"self:0xa").unwrap();
        let (_c, welcome) = self_group.add_members(&a1, &[a2.key_package().unwrap()]).unwrap();
        let mut laptop = a2.join(&welcome).unwrap();
        let payload: Vec<u8> = (0..(history::CHUNK_BYTES * 2 + 17)).map(|i| (i % 251) as u8).collect();
        let mut chunks = history::split("bundle-1", &payload);
        chunks.reverse(); // order doesn't matter
        let mut assembler = history::Reassembler::default();
        let mut done = None;
        for chunk in chunks {
            let ct = self_group.encrypt(&a1, &chunk).unwrap();
            if let Processed::Application { plaintext, .. } = laptop.process(&a2, &ct).unwrap() {
                if let Some(bundle) = history::parse_chunk(&plaintext).and_then(|c| assembler.push(c)) {
                    done = Some(bundle);
                }
            }
        }
        assert_eq!(done, Some(("bundle-1".to_string(), payload)));
    }

    #[test]
    fn device_state_survives_a_restart() {
        let alice = certified("0xa", "phone");
        let bob = certified("0xb", "phone");
        let mut ag = alice.create_group(b"g").unwrap();
        let (_c, welcome) = ag.add_members(&alice, &[bob.key_package().unwrap()]).unwrap();
        let mut bg = bob.join(&welcome).unwrap();
        bg.process(&bob, &ag.encrypt(&alice, b"before").unwrap()).unwrap();

        // Bob's app restarts: restore device + group from the snapshot.
        let snapshot = bob.snapshot().unwrap();
        drop(bg);
        drop(bob);
        let bob = Device::restore(&snapshot).unwrap();
        let mut bg = bob.load_group(b"g").unwrap().expect("group restored");
        assert_eq!(bg.epoch(), ag.epoch());
        assert_eq!(bob.identity(), certified_identity_wallet(&bob));
        assert!(matches!(
            bg.process(&bob, &ag.encrypt(&alice, b"after").unwrap()).unwrap(),
            Processed::Application { .. }
        ));
        // And it can still send.
        let ct = bg.encrypt(&bob, b"reply").unwrap();
        assert!(matches!(ag.process(&alice, &ct).unwrap(), Processed::Application { .. }));
        assert!(Device::restore(b"garbage").is_err());
    }

    fn certified_identity_wallet(device: &Device) -> Vec<u8> {
        device.identity()
    }

    /// Spike numbers (run with `cargo test --release -- --nocapture timings`).
    #[test]
    fn timings() {
        for n in [2usize, 50, 500] {
            let creator = Device::new(b"creator").unwrap();
            let others: Vec<Device> = (0..n - 1).map(|i| Device::new(format!("d{i}").as_bytes()).unwrap()).collect();
            let kps: Vec<Vec<u8>> = others.iter().map(|d| d.key_package().unwrap()).collect();
            let mut g = creator.create_group(b"bench").unwrap();
            let t = Instant::now();
            let (_c, welcome) = g.add_members(&creator, &kps).unwrap();
            let add = t.elapsed();
            let mut member = others[0].join(&welcome).unwrap();
            let t = Instant::now();
            let commit = g.self_update(&creator).unwrap();
            let update = t.elapsed();
            let t = Instant::now();
            member.process(&others[0], &commit).unwrap();
            let apply = t.elapsed();
            let t = Instant::now();
            let mut last = Vec::new();
            for _ in 0..100 {
                last = g.encrypt(&creator, &[0u8; 256]).unwrap();
            }
            let enc = t.elapsed() / 100;
            println!(
                "members={n} add_all={add:?} self_update={update:?} apply_commit={apply:?} encrypt_256B={enc:?} msg_bytes={} welcome_bytes={}",
                last.len(),
                welcome.len()
            );
        }
    }
}
