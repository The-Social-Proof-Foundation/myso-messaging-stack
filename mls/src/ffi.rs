//! Swift (iOS) bindings via UniFFI. Same surface as the WASM bindings; the iOS app owns persistence
//! (`snapshot()` after every mutating call, sealed with a Keychain key) and the single writer.

use std::sync::{Arc, Mutex};

use crate::{history, Device, DeviceCertificate, DeviceKeys, Group, MessageInfo, Processed};

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum FfiMlsError {
    #[error("{message}")]
    Failed { message: String },
}

impl From<crate::MlsError> for FfiMlsError {
    fn from(e: crate::MlsError) -> Self {
        FfiMlsError::Failed { message: e.to_string() }
    }
}

type R<T> = Result<T, FfiMlsError>;

fn poisoned<T>(_: T) -> FfiMlsError {
    FfiMlsError::Failed { message: "state lock poisoned".into() }
}

#[derive(uniffi::Object)]
pub struct MlsDeviceKeys(Mutex<Option<DeviceKeys>>);

#[uniffi::export]
impl MlsDeviceKeys {
    #[uniffi::constructor]
    pub fn generate() -> R<Arc<Self>> {
        Ok(Arc::new(Self(Mutex::new(Some(DeviceKeys::generate()?)))))
    }
    #[uniffi::constructor]
    pub fn from_secret_bytes(bytes: Vec<u8>) -> R<Arc<Self>> {
        Ok(Arc::new(Self(Mutex::new(Some(DeviceKeys::from_secret_bytes(&bytes)?)))))
    }
    pub fn public_key(&self) -> Vec<u8> {
        self.0.lock().ok().and_then(|k| k.as_ref().map(|k| k.public_key())).unwrap_or_default()
    }
    pub fn secret_bytes(&self) -> R<Vec<u8>> {
        let guard = self.0.lock().map_err(poisoned)?;
        Ok(guard.as_ref().ok_or(FfiMlsError::Failed { message: "keys consumed".into() })?.to_secret_bytes()?)
    }
    /// Raw ed25519 signature (authority keys: v2 certificates).
    pub fn sign(&self, message: Vec<u8>) -> R<Vec<u8>> {
        let guard = self.0.lock().map_err(poisoned)?;
        Ok(guard.as_ref().ok_or(FfiMlsError::Failed { message: "keys consumed".into() })?.sign(&message)?)
    }
}

/// Issue a v2 device certificate signed by `authority`; returns its JSON (the MLS identity).
#[uniffi::export]
pub fn mls_issue_certificate_v2(
    authority: Arc<MlsDeviceKeys>,
    wallet: String,
    device_id: String,
    mls_key_hex: String,
    issued_at_ms: i64,
) -> R<String> {
    let guard = authority.0.lock().map_err(poisoned)?;
    let keys = guard.as_ref().ok_or(FfiMlsError::Failed { message: "keys consumed".into() })?;
    let cert = crate::DeviceCertificate::issue_v2(keys, &wallet, &device_id, &mls_key_hex, issued_at_ms)?;
    serde_json::to_string(&cert).map_err(|e| FfiMlsError::Failed { message: e.to_string() })
}

/// Whether a v2 certificate JSON's authority signature verifies (the registry check is separate).
#[uniffi::export]
pub fn mls_verify_certificate_v2(json: String) -> bool {
    serde_json::from_str::<crate::DeviceCertificate>(&json).is_ok_and(|c| c.verify_authority_signature())
}

#[derive(uniffi::Object)]
pub struct MlsDevice(Device);

#[derive(uniffi::Object)]
pub struct MlsGroup(Mutex<Group>);

#[derive(uniffi::Record)]
pub struct MlsProcessed {
    /// `application` | `commit` | `proposal` | `own`
    pub kind: String,
    pub plaintext: Option<Vec<u8>>,
    pub sender_identity: Option<Vec<u8>>,
    pub epoch: Option<u64>,
}

#[derive(uniffi::Record)]
pub struct MlsCommitWelcome {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct MlsExternalJoin {
    pub group: Arc<MlsGroup>,
    pub commit: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct MlsMember {
    pub leaf_index: u32,
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
    /// Wallet from a certificate that names this leaf's key (signature still needs verifying).
    pub certificate_wallet: Option<String>,
    pub certificate_json: Option<String>,
}

#[derive(uniffi::Record)]
pub struct MlsMessageInfo {
    pub kind: String,
    pub group_id: Option<String>,
    pub epoch: Option<u64>,
}

#[derive(uniffi::Record)]
pub struct MlsHistoryBundle {
    pub bundle_id: String,
    pub payload: Vec<u8>,
}

#[uniffi::export]
impl MlsDevice {
    #[uniffi::constructor]
    pub fn from_keys(keys: Arc<MlsDeviceKeys>, identity: Vec<u8>) -> R<Arc<Self>> {
        let k = keys.0.lock().map_err(poisoned)?.take().ok_or(FfiMlsError::Failed { message: "keys consumed".into() })?;
        Ok(Arc::new(Self(Device::from_keys(k, &identity)?)))
    }
    #[uniffi::constructor]
    pub fn restore(snapshot: Vec<u8>) -> R<Arc<Self>> {
        Ok(Arc::new(Self(Device::restore(&snapshot)?)))
    }
    pub fn snapshot(&self) -> R<Vec<u8>> {
        Ok(self.0.snapshot()?)
    }
    pub fn identity(&self) -> Vec<u8> {
        self.0.identity()
    }
    pub fn key_package(&self) -> R<Vec<u8>> {
        Ok(self.0.key_package()?)
    }
    pub fn create_group(&self, group_id: Vec<u8>) -> R<Arc<MlsGroup>> {
        Ok(Arc::new(MlsGroup(Mutex::new(self.0.create_group(&group_id)?))))
    }
    pub fn join(&self, welcome: Vec<u8>) -> R<Arc<MlsGroup>> {
        Ok(Arc::new(MlsGroup(Mutex::new(self.0.join(&welcome)?))))
    }
    pub fn join_external(&self, group_info: Vec<u8>) -> R<MlsExternalJoin> {
        let (group, commit) = self.0.join_external(&group_info)?;
        Ok(MlsExternalJoin { group: Arc::new(MlsGroup(Mutex::new(group))), commit })
    }
    pub fn rejoin_external(&self, group_info: Vec<u8>) -> R<MlsExternalJoin> {
        let (group, commit) = self.0.rejoin_external(&group_info)?;
        Ok(MlsExternalJoin { group: Arc::new(MlsGroup(Mutex::new(group))), commit })
    }
    pub fn delete_group(&self, group_id: Vec<u8>) -> R<()> {
        Ok(self.0.delete_group(&group_id)?)
    }
    /// A copy of this device carrying a renewed certificate (swap to it; reload groups).
    pub fn with_identity(&self, identity: Vec<u8>) -> R<Arc<MlsDevice>> {
        Ok(Arc::new(MlsDevice(self.0.with_identity(&identity)?)))
    }
    pub fn load_group(&self, group_id: Vec<u8>) -> R<Option<Arc<MlsGroup>>> {
        Ok(self.0.load_group(&group_id)?.map(|g| Arc::new(MlsGroup(Mutex::new(g)))))
    }
}

#[uniffi::export]
impl MlsGroup {
    pub fn epoch(&self) -> u64 {
        self.0.lock().map(|g| g.epoch()).unwrap_or(0)
    }
    pub fn is_active(&self) -> bool {
        self.0.lock().map(|g| g.is_active()).unwrap_or(false)
    }
    pub fn members(&self) -> Vec<MlsMember> {
        let Ok(g) = self.0.lock() else { return vec![] };
        g.members()
            .into_iter()
            .map(|m| {
                let cert = m.certificate();
                MlsMember {
                    leaf_index: m.leaf_index,
                    certificate_wallet: cert.as_ref().map(|c| c.wallet.clone()),
                    certificate_json: cert.and_then(|c| serde_json::to_string(&c).ok()),
                    identity: m.identity,
                    signature_key: m.signature_key,
                }
            })
            .collect()
    }
    pub fn add_members(&self, device: Arc<MlsDevice>, key_packages: Vec<Vec<u8>>) -> R<MlsCommitWelcome> {
        let (commit, welcome) = self.0.lock().map_err(poisoned)?.add_members(&device.0, &key_packages)?;
        Ok(MlsCommitWelcome { commit, welcome })
    }
    pub fn remove_leaves(&self, device: Arc<MlsDevice>, leaves: Vec<u32>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.remove_leaves(&device.0, &leaves)?)
    }
    /// Commit the device's current (renewed) credential into this group.
    pub fn update_credential(&self, device: Arc<MlsDevice>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.update_credential(&device.0)?)
    }
    pub fn self_update(&self, device: Arc<MlsDevice>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.self_update(&device.0)?)
    }
    pub fn group_info(&self, device: Arc<MlsDevice>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.group_info(&device.0)?)
    }
    pub fn leave(&self, device: Arc<MlsDevice>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.leave(&device.0)?)
    }
    pub fn commit_pending(&self, device: Arc<MlsDevice>) -> R<Option<Vec<u8>>> {
        Ok(self.0.lock().map_err(poisoned)?.commit_pending(&device.0)?)
    }
    pub fn encrypt(&self, device: Arc<MlsDevice>, plaintext: Vec<u8>) -> R<Vec<u8>> {
        Ok(self.0.lock().map_err(poisoned)?.encrypt(&device.0, &plaintext)?)
    }
    pub fn process(&self, device: Arc<MlsDevice>, message: Vec<u8>) -> R<MlsProcessed> {
        let p = |kind: &str| MlsProcessed { kind: kind.into(), plaintext: None, sender_identity: None, epoch: None };
        Ok(match self.0.lock().map_err(poisoned)?.process(&device.0, &message)? {
            Processed::Application { plaintext, sender_identity } => MlsProcessed {
                plaintext: Some(plaintext),
                sender_identity: Some(sender_identity),
                ..p("application")
            },
            Processed::Commit { epoch } => MlsProcessed { epoch: Some(epoch), ..p("commit") },
            Processed::Proposal => p("proposal"),
            Processed::Own => p("own"),
        })
    }
}

#[uniffi::export]
pub fn mls_inspect(bytes: Vec<u8>) -> R<MlsMessageInfo> {
    let (kind, group, epoch) = match crate::inspect(&bytes)? {
        MessageInfo::Application { group_id, epoch } => ("application", Some(group_id), Some(epoch)),
        MessageInfo::Commit { group_id, epoch } => ("commit", Some(group_id), Some(epoch)),
        MessageInfo::Proposal { group_id, epoch } => ("proposal", Some(group_id), Some(epoch)),
        MessageInfo::GroupInfo { group_id, epoch } => ("group_info", Some(group_id), Some(epoch)),
        MessageInfo::Welcome => ("welcome", None, None),
        MessageInfo::KeyPackage => ("key_package", None, None),
        MessageInfo::Other => ("other", None, None),
    };
    Ok(MlsMessageInfo {
        kind: kind.into(),
        group_id: group.map(|g| String::from_utf8_lossy(&g).into_owned()),
        epoch,
    })
}

/// Certificate JSON a KeyPackage carries when it names the KeyPackage's leaf key (`None` otherwise).
#[uniffi::export]
pub fn mls_key_package_certificate(key_package: Vec<u8>) -> Option<String> {
    let member = crate::key_package_member(&key_package).ok()?;
    member.certificate().and_then(|c| serde_json::to_string(&c).ok())
}

#[uniffi::export]
pub fn mls_certificate_canonical(wallet: String, device_id: String, mls_key_hex: String, issued_at_ms: i64) -> String {
    DeviceCertificate::canonical(&wallet, &device_id, &mls_key_hex, issued_at_ms)
}

#[uniffi::export]
pub fn mls_history_split(bundle_id: String, payload: Vec<u8>) -> Vec<Vec<u8>> {
    history::split(&bundle_id, &payload)
}

#[derive(uniffi::Object)]
pub struct MlsHistoryReassembler(Mutex<history::Reassembler>);

#[uniffi::export]
impl MlsHistoryReassembler {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(history::Reassembler::default())))
    }
    /// Feed one application plaintext; returns a bundle when complete.
    pub fn push(&self, plaintext: Vec<u8>) -> Option<MlsHistoryBundle> {
        let chunk = history::parse_chunk(&plaintext)?;
        let (bundle_id, payload) = self.0.lock().ok()?.push(chunk)?;
        Some(MlsHistoryBundle { bundle_id, payload })
    }
}
