pub fn collapse_metatype_qname(raw: &str) -> Option<String> {
    let parts = raw
        .split("::")
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return None;
    }
    Some(format!("{}::{}", parts[0], parts[parts.len() - 1]))
}

pub fn tail_name(raw: &str) -> String {
    raw.rsplit("::").next().unwrap_or(raw).to_string()
}

pub fn best_tail_candidate(raw: &str, candidates: &[String]) -> Option<String> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some(candidates[0].clone());
    }
    let raw_parts = raw
        .split("::")
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let raw_set = raw_parts.iter().cloned().collect::<std::collections::HashSet<_>>();
    let has_namespace = raw_parts.len() > 1;
    candidates
        .iter()
        .map(|candidate| {
            let c_parts = candidate
                .split("::")
                .filter(|value| !value.is_empty())
                .map(|value| value.to_ascii_lowercase())
                .collect::<Vec<_>>();
            let overlap = c_parts.iter().filter(|part| raw_set.contains(*part)).count() as i32;
            let namespace_bonus = if has_namespace && c_parts.len() > 1 { 2 } else { 0 };
            let depth_bonus = c_parts.len() as i32;
            (candidate.clone(), overlap * 10 + namespace_bonus + depth_bonus)
        })
        .max_by(|a, b| a.1.cmp(&b.1).then(a.0.len().cmp(&b.0.len())))
        .map(|(candidate, _)| candidate)
}
