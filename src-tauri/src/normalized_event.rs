use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub event_id: String,
    /// Unix time in milliseconds, converted to ISO 8601 by the presentation layer.
    pub timestamp: u128,
    pub agent_type: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub event_type: String,
    pub lifecycle_status: Option<String>,
    pub tool_name: Option<String>,
    pub request_id: Option<String>,
    pub metadata: Value,
}

pub fn new_event(
    sequence: &AtomicU64,
    session_id: Option<String>,
    turn_id: Option<String>,
    event_type: impl Into<String>,
    lifecycle_status: Option<String>,
    tool_name: Option<String>,
    request_id: Option<String>,
    metadata: Value,
) -> NormalizedEvent {
    let id = sequence.fetch_add(1, Ordering::Relaxed) + 1;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    NormalizedEvent {
        event_id: format!("azalee-{id}"),
        timestamp,
        agent_type: "codex".to_string(),
        session_id,
        turn_id,
        event_type: event_type.into(),
        lifecycle_status,
        tool_name,
        request_id,
        metadata,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn normalized_events_have_stable_agent_neutral_fields() {
        let sequence = AtomicU64::new(0);
        let event = new_event(
            &sequence,
            Some("thread-1".into()),
            Some("turn-1".into()),
            "turn.started",
            Some("in_progress".into()),
            None,
            None,
            serde_json::json!({"source": "app-server"}),
        );
        assert_eq!(event.event_id, "azalee-1");
        assert_eq!(event.agent_type, "codex");
        assert_eq!(event.event_type, "turn.started");
        assert!(event.timestamp > 0);
    }
}
