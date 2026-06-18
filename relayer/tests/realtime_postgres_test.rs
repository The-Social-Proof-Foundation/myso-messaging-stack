//! Realtime NOTIFY metadata tests.

use messaging_relayer::services::realtime::MessageCreatedEvent;
use uuid::Uuid;

#[test]
fn notify_payload_is_metadata_only() {
    let event = MessageCreatedEvent::new(
        "group-1".to_string(),
        Uuid::new_v4(),
        42,
        "0xsender".to_string(),
    );
    let json = serde_json::to_string(&event).unwrap();

    assert!(json.contains("\"type\":\"message.created\""));
    assert!(json.contains("message_id"));
    assert!(json.contains("group_id"));
    assert!(!json.contains("encrypted"));
    assert!(!json.contains("nonce"));
}
