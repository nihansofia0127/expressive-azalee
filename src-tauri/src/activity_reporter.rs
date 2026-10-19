//! Minimal stdio MCP server used only when activity reporting is enabled.
//! The App Server's mcpToolCall/item-start event is the reporting signal; this
//! process itself stores and transmits no task content.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const ACTIVITY_TOOL: &str = "report_activity";
const ACTIVITIES: [&str; 3] = ["CODING", "WRITING", "DELETING"];

pub fn run() -> i32 {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { return 1 };
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned();
        let Some(method) = request.get("method").and_then(Value::as_str) else { continue };
        let Some(id) = id else { continue }; // MCP notifications have no response.

        let result = match method {
            "initialize" => Some(json!({
                "protocolVersion": request.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "azalee-activity-reporter", "version": "0.1.0"},
                "instructions": "When activity reporting is enabled, call report_activity immediately before a matching Coding, Writing, or Deleting operation you are about to perform. Do not call it for generic or ambiguous work; Azalee uses Working when no semantic report is sent. This reports intent only, not proof of execution."
            })),
            "ping" => Some(json!({})),
            "tools/list" => Some(json!({"tools": [tool_definition()]})),
            "tools/call" => Some(call_tool(&request)),
            _ => None,
        };
        if let Some(result) = result {
            if serde_json::to_writer(&mut stdout, &json!({"jsonrpc": "2.0", "id": id, "result": result})).is_err()
                || stdout.write_all(b"\n").is_err()
                || stdout.flush().is_err()
            {
                return 1;
            }
        } else if method != "notifications/initialized" && method != "notifications/cancelled" {
            let error = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Unsupported MCP method"}});
            if serde_json::to_writer(&mut stdout, &error).is_err() || stdout.write_all(b"\n").is_err() || stdout.flush().is_err() { return 1; }
        }
    }
    0
}

fn tool_definition() -> Value {
    json!({
        "name": ACTIVITY_TOOL,
        "description": "Report a planned Coding, Writing, or Deleting activity immediately before you begin it. Do not call this for generic or ambiguous work; Azalee uses Working when no report is sent. The report is an unverified intention and does not perform the operation. Call once for a matching operation only when you are about to proceed.",
        "inputSchema": {
            "type": "object",
            "properties": {
        "activity": {"type": "string", "enum": ACTIVITIES},
                "stage": {"type": "string", "enum": ["intended"]}
            },
            "required": ["activity", "stage"],
            "additionalProperties": false
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "activity": {"type": "string", "enum": ACTIVITIES},
                "stage": {"type": "string", "enum": ["intended"]}
            },
            "required": ["activity", "stage"],
            "additionalProperties": false
        }
    })
}

pub fn validated_report(arguments: &Value) -> Option<(&'static str, &'static str)> {
    let activity = arguments.get("activity")?.as_str()?;
    if !ACTIVITIES.contains(&activity) { return None; }
    if arguments.get("stage")?.as_str()? != "intended" { return None; }
    if arguments.as_object()?.keys().any(|key| key != "activity" && key != "stage") { return None; }
    let activity = match activity {
        "CODING" => "CODING",
        "WRITING" => "WRITING",
        "DELETING" => "DELETING",
        _ => return None,
    };
    Some((activity, "intended"))
}

fn call_tool(request: &Value) -> Value {
    let params = request.get("params").unwrap_or(&Value::Null);
    if params.get("name").and_then(Value::as_str) != Some(ACTIVITY_TOOL) {
        return json!({"isError": true, "content": [{"type": "text", "text": "Unknown activity report tool."}]});
    }
    match validated_report(params.get("arguments").unwrap_or(&Value::Null)) {
        Some((activity, stage)) => {
            let structured = json!({"activity": activity, "stage": stage});
            json!({
                "content": [{"type": "text", "text": structured.to_string()}],
                "structuredContent": structured,
                "isError": false
            })
        },
        None => json!({"isError": true, "content": [{"type": "text", "text": "Invalid activity report."}]}),
    }
}

#[cfg(test)]
mod tests {
    use super::{call_tool, validated_report};
    use serde_json::json;

    #[test]
    fn accepts_only_allowlisted_intended_activity() {
        assert_eq!(validated_report(&json!({"activity":"CODING","stage":"intended"})), Some(("CODING", "intended")));
    }

    #[test]
    fn rejects_unknown_malformed_and_extra_report_fields() {
        for value in [
            json!({"activity":"PAINTING","stage":"intended"}),
            json!({"activity":"WORKING","stage":"intended"}),
            json!({"activity":"CODING","stage":"executing"}),
            json!({"activity":4,"stage":"intended"}),
            json!({"activity":"WRITING","stage":"intended","prompt":"private"}),
            json!(null),
        ] {
            assert_eq!(validated_report(&value), None);
        }
    }

    #[test]
    fn successful_tool_result_has_an_explicit_success_flag_and_matching_structured_content() {
        let result = call_tool(&json!({"params":{"name":"report_activity","arguments":{"activity":"CODING","stage":"intended"}}}));
        assert_eq!(result["isError"], false);
        assert_eq!(result["structuredContent"], json!({"activity":"CODING","stage":"intended"}));
        assert_eq!(result["content"][0]["text"], "{\"activity\":\"CODING\",\"stage\":\"intended\"}");
    }
}
