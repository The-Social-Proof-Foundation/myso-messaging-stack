//! JS bindings (web app + Node agents). Bytes in, bytes out; mirrors the Rust API.
//! The SDK (`src/mls/`) owns persistence: call `snapshot()` after every mutating call.

use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::{history, Device, DeviceCertificate, DeviceKeys, Group, MessageInfo, Processed};

fn js_err(e: crate::MlsError) -> JsError {
    JsError::new(&e.to_string())
}

fn bytes_list(list: &Array) -> Vec<Vec<u8>> {
    list.iter().map(|v| Uint8Array::new(&v).to_vec()).collect()
}

fn to_array(items: Vec<Vec<u8>>) -> Array {
    items.into_iter().map(|b| JsValue::from(Uint8Array::from(&b[..]))).collect()
}

#[wasm_bindgen]
pub struct MlsDeviceKeys(Option<DeviceKeys>);

#[wasm_bindgen]
impl MlsDeviceKeys {
    pub fn generate() -> Result<MlsDeviceKeys, JsError> {
        DeviceKeys::generate().map(|k| MlsDeviceKeys(Some(k))).map_err(js_err)
    }
    #[wasm_bindgen(js_name = fromSecretBytes)]
    pub fn from_secret_bytes(bytes: &[u8]) -> Result<MlsDeviceKeys, JsError> {
        DeviceKeys::from_secret_bytes(bytes).map(|k| MlsDeviceKeys(Some(k))).map_err(js_err)
    }
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.0.as_ref().map(|k| k.public_key()).unwrap_or_default()
    }
    #[wasm_bindgen(js_name = secretBytes)]
    pub fn secret_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.0.as_ref().ok_or_else(|| JsError::new("keys consumed"))?.to_secret_bytes().map_err(js_err)
    }
    /// Raw ed25519 signature (authority keys: registry tx bytes are signed by the platform SDK,
    /// this is for v2 certificates).
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.as_ref().ok_or_else(|| JsError::new("keys consumed"))?.sign(message).map_err(js_err)
    }
}

/// Issue a v2 device certificate signed by `authority`; returns its JSON (the MLS identity).
#[wasm_bindgen(js_name = mlsIssueCertificateV2)]
pub fn issue_certificate_v2(
    authority: &MlsDeviceKeys,
    wallet: &str,
    device_id: &str,
    mls_key_hex: &str,
    issued_at_ms: f64,
) -> Result<String, JsError> {
    let keys = authority.0.as_ref().ok_or_else(|| JsError::new("keys consumed"))?;
    let cert = crate::DeviceCertificate::issue_v2(keys, wallet, device_id, mls_key_hex, issued_at_ms as i64)
        .map_err(js_err)?;
    serde_json::to_string(&cert).map_err(|e| JsError::new(&e.to_string()))
}

/// Whether a v2 certificate JSON's authority signature verifies (the registry check is separate).
#[wasm_bindgen(js_name = mlsVerifyCertificateV2)]
pub fn verify_certificate_v2(json: &str) -> bool {
    serde_json::from_str::<crate::DeviceCertificate>(json).is_ok_and(|c| c.verify_authority_signature())
}

#[wasm_bindgen]
pub struct MlsDevice(Device);

#[wasm_bindgen]
pub struct MlsGroup(Group);

#[wasm_bindgen(getter_with_clone)]
pub struct MlsProcessed {
    /// `application` | `commit` | `proposal` | `own`
    pub kind: String,
    pub plaintext: Option<Vec<u8>>,
    #[wasm_bindgen(js_name = senderIdentity)]
    pub sender_identity: Option<Vec<u8>>,
    pub epoch: Option<u64>,
}

#[wasm_bindgen(getter_with_clone)]
pub struct MlsCommitWelcome {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

#[wasm_bindgen]
pub struct MlsExternalJoin {
    group: Option<Group>,
    commit: Vec<u8>,
}

#[wasm_bindgen]
impl MlsExternalJoin {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Vec<u8> {
        self.commit.clone()
    }
    /// Take the joined group (once).
    #[wasm_bindgen(js_name = takeGroup)]
    pub fn take_group(&mut self) -> Result<MlsGroup, JsError> {
        self.group.take().map(MlsGroup).ok_or_else(|| JsError::new("group already taken"))
    }
}

#[wasm_bindgen]
impl MlsDevice {
    /// Test helper: random keys, raw identity.
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8]) -> Result<MlsDevice, JsError> {
        Device::new(identity).map(MlsDevice).map_err(js_err)
    }
    /// Production: persisted keys + the wallet-signed certificate JSON as identity.
    #[wasm_bindgen(js_name = fromKeys)]
    pub fn from_keys(keys: &mut MlsDeviceKeys, identity: &[u8]) -> Result<MlsDevice, JsError> {
        let keys = keys.0.take().ok_or_else(|| JsError::new("keys consumed"))?;
        Device::from_keys(keys, identity).map(MlsDevice).map_err(js_err)
    }
    pub fn restore(snapshot: &[u8]) -> Result<MlsDevice, JsError> {
        Device::restore(snapshot).map(MlsDevice).map_err(js_err)
    }
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.0.snapshot().map_err(js_err)
    }
    pub fn identity(&self) -> Vec<u8> {
        self.0.identity()
    }
    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&self) -> Result<Vec<u8>, JsError> {
        self.0.key_package().map_err(js_err)
    }
    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&self, group_id: &[u8]) -> Result<MlsGroup, JsError> {
        self.0.create_group(group_id).map(MlsGroup).map_err(js_err)
    }
    pub fn join(&self, welcome: &[u8]) -> Result<MlsGroup, JsError> {
        self.0.join(welcome).map(MlsGroup).map_err(js_err)
    }
    #[wasm_bindgen(js_name = joinExternal)]
    pub fn join_external(&self, group_info: &[u8]) -> Result<MlsExternalJoin, JsError> {
        let (group, commit) = self.0.join_external(group_info).map_err(js_err)?;
        Ok(MlsExternalJoin { group: Some(group), commit })
    }
    #[wasm_bindgen(js_name = rejoinExternal)]
    pub fn rejoin_external(&self, group_info: &[u8]) -> Result<MlsExternalJoin, JsError> {
        let (group, commit) = self.0.rejoin_external(group_info).map_err(js_err)?;
        Ok(MlsExternalJoin { group: Some(group), commit })
    }
    #[wasm_bindgen(js_name = deleteGroup)]
    pub fn delete_group(&self, group_id: &[u8]) -> Result<(), JsError> {
        self.0.delete_group(group_id).map_err(js_err)
    }
    /// A copy of this device carrying a renewed certificate (swap to it; reload groups).
    #[wasm_bindgen(js_name = withIdentity)]
    pub fn with_identity(&self, identity: &[u8]) -> Result<MlsDevice, JsError> {
        self.0.with_identity(identity).map(MlsDevice).map_err(js_err)
    }
    #[wasm_bindgen(js_name = loadGroup)]
    pub fn load_group(&self, group_id: &[u8]) -> Result<Option<MlsGroup>, JsError> {
        Ok(self.0.load_group(group_id).map_err(js_err)?.map(MlsGroup))
    }
}

#[wasm_bindgen]
impl MlsGroup {
    pub fn epoch(&self) -> u64 {
        self.0.epoch()
    }
    #[wasm_bindgen(js_name = isActive)]
    pub fn is_active(&self) -> bool {
        self.0.is_active()
    }
    /// JSON `[{ leafIndex, identityHex, signatureKeyHex, wallet?, deviceId?, certificate? }]`;
    /// `certificate` (when present) names this leaf's key — the wallet signature still needs
    /// platform verification.
    #[wasm_bindgen(js_name = membersJson)]
    pub fn members_json(&self) -> String {
        let list: Vec<_> = self
            .0
            .members()
            .into_iter()
            .map(|m| {
                let cert = m.certificate();
                serde_json::json!({
                    "leafIndex": m.leaf_index,
                    "identityHex": hex::encode(&m.identity),
                    "signatureKeyHex": hex::encode(&m.signature_key),
                    "certificate": cert,
                })
            })
            .collect();
        serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
    }
    #[wasm_bindgen(js_name = addMembers)]
    pub fn add_members(&mut self, device: &MlsDevice, key_packages: &Array) -> Result<MlsCommitWelcome, JsError> {
        let (commit, welcome) = self.0.add_members(&device.0, &bytes_list(key_packages)).map_err(js_err)?;
        Ok(MlsCommitWelcome { commit, welcome })
    }
    #[wasm_bindgen(js_name = removeLeaves)]
    pub fn remove_leaves(&mut self, device: &MlsDevice, leaves: Vec<u32>) -> Result<Vec<u8>, JsError> {
        self.0.remove_leaves(&device.0, &leaves).map_err(js_err)
    }
    /// Commit the device's current (renewed) credential into this group.
    #[wasm_bindgen(js_name = updateCredential)]
    pub fn update_credential(&mut self, device: &MlsDevice) -> Result<Vec<u8>, JsError> {
        self.0.update_credential(&device.0).map_err(js_err)
    }
    #[wasm_bindgen(js_name = selfUpdate)]
    pub fn self_update(&mut self, device: &MlsDevice) -> Result<Vec<u8>, JsError> {
        self.0.self_update(&device.0).map_err(js_err)
    }
    #[wasm_bindgen(js_name = groupInfo)]
    pub fn group_info(&self, device: &MlsDevice) -> Result<Vec<u8>, JsError> {
        self.0.group_info(&device.0).map_err(js_err)
    }
    pub fn leave(&mut self, device: &MlsDevice) -> Result<Vec<u8>, JsError> {
        self.0.leave(&device.0).map_err(js_err)
    }
    #[wasm_bindgen(js_name = commitPending)]
    pub fn commit_pending(&mut self, device: &MlsDevice) -> Result<Option<Vec<u8>>, JsError> {
        self.0.commit_pending(&device.0).map_err(js_err)
    }
    pub fn encrypt(&mut self, device: &MlsDevice, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.encrypt(&device.0, plaintext).map_err(js_err)
    }
    pub fn process(&mut self, device: &MlsDevice, message: &[u8]) -> Result<MlsProcessed, JsError> {
        let p = |kind: &str| MlsProcessed { kind: kind.into(), plaintext: None, sender_identity: None, epoch: None };
        Ok(match self.0.process(&device.0, message).map_err(js_err)? {
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

/// JSON `{ kind, groupId?, epoch? }` from the cleartext MLS header.
#[wasm_bindgen(js_name = mlsInspect)]
pub fn inspect(bytes: &[u8]) -> Result<String, JsError> {
    let (kind, group, epoch) = match crate::inspect(bytes).map_err(js_err)? {
        MessageInfo::Application { group_id, epoch } => ("application", Some(group_id), Some(epoch)),
        MessageInfo::Commit { group_id, epoch } => ("commit", Some(group_id), Some(epoch)),
        MessageInfo::Proposal { group_id, epoch } => ("proposal", Some(group_id), Some(epoch)),
        MessageInfo::GroupInfo { group_id, epoch } => ("group_info", Some(group_id), Some(epoch)),
        MessageInfo::Welcome => ("welcome", None, None),
        MessageInfo::KeyPackage => ("key_package", None, None),
        MessageInfo::Other => ("other", None, None),
    };
    Ok(serde_json::json!({
        "kind": kind,
        "groupId": group.map(|g| String::from_utf8_lossy(&g).into_owned()),
        "epoch": epoch,
    })
    .to_string())
}

/// The certificate JSON a KeyPackage carries, when it names the KeyPackage's own leaf key
/// (clients verify claimed KeyPackages before adding them; the relayer is not trusted for this).
#[wasm_bindgen(js_name = mlsKeyPackageCertificate)]
pub fn key_package_certificate(key_package: &[u8]) -> Option<String> {
    let member = crate::key_package_member(key_package).ok()?;
    member.certificate().and_then(|c| serde_json::to_string(&c).ok())
}

#[wasm_bindgen(js_name = mlsCertificateCanonical)]
pub fn certificate_canonical(wallet: &str, device_id: &str, mls_key_hex: &str, issued_at_ms: f64) -> String {
    DeviceCertificate::canonical(wallet, device_id, mls_key_hex, issued_at_ms as i64)
}

#[wasm_bindgen(js_name = mlsHistorySplit)]
pub fn history_split(bundle_id: &str, payload: &[u8]) -> Array {
    to_array(history::split(bundle_id, payload))
}

#[wasm_bindgen]
pub struct MlsHistoryReassembler(history::Reassembler);

#[wasm_bindgen(getter_with_clone)]
pub struct MlsHistoryBundle {
    #[wasm_bindgen(js_name = bundleId)]
    pub bundle_id: String,
    pub payload: Vec<u8>,
}

#[wasm_bindgen]
impl MlsHistoryReassembler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MlsHistoryReassembler {
        MlsHistoryReassembler(history::Reassembler::default())
    }
    /// Feed one application plaintext; returns a bundle when complete, else undefined.
    /// Non-history plaintexts are ignored.
    pub fn push(&mut self, plaintext: &[u8]) -> Option<MlsHistoryBundle> {
        let chunk = history::parse_chunk(plaintext)?;
        self.0.push(chunk).map(|(bundle_id, payload)| MlsHistoryBundle { bundle_id, payload })
    }
}
