//! Derive messaging singleton actor object IDs (GroupLeaver / GroupManager).

use std::collections::HashSet;
use std::str::FromStr;

use myso_sdk_types::{Address, TypeTag};

/// Matches Move `GROUP_LEAVER_DERIVATION_KEY` / TS `GROUP_LEAVER_DERIVATION_KEY`.
const GROUP_LEAVER_DERIVATION_KEY: &str = "group_leaver";
/// Matches Move `GROUP_MANAGER_DERIVATION_KEY` / TS `GROUP_MANAGER_DERIVATION_KEY`.
const GROUP_MANAGER_DERIVATION_KEY: &str = "group_manager";

/// Derive GroupLeaver + GroupManager object IDs from the MessagingNamespace.
///
/// Returns an empty set when `namespace_id` is missing or invalid so callers
/// can degrade gracefully (may emit system-actor join events until configured).
pub fn system_object_addresses(namespace_id: Option<&str>) -> HashSet<String> {
    let Some(ns) = namespace_id.filter(|s| !s.is_empty()) else {
        return HashSet::new();
    };
    let Ok(parent) = Address::from_str(ns) else {
        return HashSet::new();
    };
    let Ok(key_type) = TypeTag::from_str("0x1::string::String") else {
        return HashSet::new();
    };

    let mut out = HashSet::new();
    for key in [GROUP_LEAVER_DERIVATION_KEY, GROUP_MANAGER_DERIVATION_KEY] {
        let key_bytes = match bcs::to_bytes(key) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let id = parent.derive_object_id(&key_type, &key_bytes);
        out.insert(id.to_string());
    }
    out
}

/// Case-insensitive membership of `addr` in `system` addresses.
pub fn is_system_object(addr: &str, system: &HashSet<String>) -> bool {
    if system.is_empty() {
        return false;
    }
    let needle = addr.to_ascii_lowercase();
    system.iter().any(|s| s.eq_ignore_ascii_case(&needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_namespace_yields_empty_set() {
        assert!(system_object_addresses(None).is_empty());
        assert!(system_object_addresses(Some("")).is_empty());
    }

    #[test]
    fn localnet_namespace_derives_group_leaver_and_manager() {
        // MessagingNamespace from localnet logs (ghost joiners in DM create).
        let ns = "0x1c7ae94e75c31c71e5e9a9e02b429096541c848654f4904ba302fc469b2e9f33";
        let addrs = system_object_addresses(Some(ns));
        assert_eq!(addrs.len(), 2);
        assert!(is_system_object(
            "0xba8f4446fabd4c64bf3a096e86fbcdd615e4ffdacbb340666d82c0f226231470",
            &addrs
        ));
        assert!(is_system_object(
            "0x4fb0296f1ad688629738790e04b0d05b82a6fb80235cd25b3429855f10c3ed61",
            &addrs
        ));
        assert!(!is_system_object(
            "0x9cad51cd09f1e97d1e8031bf412dff233833b9def50a08b19c36b0fa345e5463",
            &addrs
        ));
    }
}
