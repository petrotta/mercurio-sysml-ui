use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentNextStep {
    pub id: String,
    pub label: String,
    pub recommended: bool,
    pub action: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentFinal {
    pub summary: String,
    pub next_steps: Vec<AgentNextStep>,
}

pub fn parse_agent_final(content: &str) -> Result<AgentFinal, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Empty final content".to_string());
    }
    let parsed: AgentFinal = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
    if parsed.summary.trim().is_empty() {
        return Err("Summary is required".to_string());
    }
    Ok(parsed)
}
