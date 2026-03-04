# Semantic Authority Contract

## Rule

`mercurio-sysml-ui` must treat semantic data as backend-owned.

- Semantic truth is provided by `core.*` semantic tools.
- UI must render semantic payloads, not infer missing semantics locally.

## Allowed in UI

- Selection, filtering, grouping, sorting, rendering.
- Displaying diagnostics returned by backend.
- Local UI state (expanded/collapsed, pane sizes, active tabs).

## Not allowed in UI

- Metatype inference from symbol kind/name.
- Inheritance reconstruction from metamodel fallback logic.
- Synthesizing semantic relationships not explicitly returned.

## Preferred Tool Pathways

- `core.get_project_model@v1`
- `core.get_project_element_attributes@v1`
- `core.get_stdlib_metamodel@v1`
- `core.query_semantic@v1`

## Codex Hygiene Heuristics

- Add new semantic behavior by extending backend tool payloads first.
- Keep semantic tool calls behind a typed adapter module.
- If semantic fields are missing, show backend diagnostics; do not invent values.
