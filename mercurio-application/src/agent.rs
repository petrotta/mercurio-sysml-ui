use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentNextStep {
    pub id: String,
    pub label: String,
    pub recommended: bool,
    pub action: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

impl Default for AgentPlanStepStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentPlanStep {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub status: AgentPlanStepStatus,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentPlan {
    pub goal: String,
    #[serde(default)]
    pub steps: Vec<AgentPlanStep>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentFinal {
    pub summary: String,
    #[serde(default)]
    pub next_steps: Vec<AgentNextStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<AgentPlan>,
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
