# Semantic Authority Contract

## Rule

`mercurio-sysml-ui` must treat semantic data as backend-owned.

- Semantic truth is provided by `core.*` semantic tools.
- The sibling `mercurio-sysml` repo is authoritative for semantic/model meaning, including canonical semantic feature names and derived subsets.
- `mercurio-core` may package semantic data into app-facing payloads, but it should not invent semantic truth that is absent from `mercurio-sysml`.
- UI must render semantic payloads, not infer missing semantics locally.

## Allowed in UI

- Selection, filtering, grouping, sorting, rendering.
- Displaying diagnostics returned by backend.
- Local UI state (expanded/collapsed, pane sizes, active tabs).

## Not allowed in UI

- Metatype inference from symbol kind/name.
- Inheritance reconstruction from metamodel fallback logic.
- Synthesizing semantic relationships not explicitly returned.

## Derived Subset Boundary

For derived subsets such as `ownedAttribute`, the canonical source of truth is `mercurio-sysml`.

- If a derived subset is missing in the UI, first treat it as an upstream semantic-projection gap.
- `mercurio-sysml-ui` must not paper over that gap by inventing local semantic features such as alternate or pluralized names.
- Application-layer aggregation is allowed, but semantic feature identity must remain aligned with the authoritative upstream contract.

## Current Root-Cause Example

The `constrainttest.sysml` `Component` case exposed a local boundary violation:

- `mercurio-core` synthesized a local property named `ownedAttributes`.
- The authoritative metamodel/semantic contract uses `ownedAttribute`.
- The UI property path then had to reconcile a non-canonical local feature name with the canonical upstream attribute name.

This is not a React rendering problem. It is a semantic-authority problem in the `mercurio-sysml-ui` stack.

The correct long-term fix direction is:

- make `mercurio-sysml` emit the canonical derived subset when available;
- consume that canonical feature in `mercurio-core`;
- keep the UI as a renderer of backend-owned semantic payloads.

## Preferred Tool Pathways

- `core.get_project_model@v1`
- `core.get_project_element_attributes@v1`
- `core.get_stdlib_metamodel@v1`
- `core.query_semantic@v1`

## Codex Hygiene Heuristics

- Add new semantic behavior by extending backend tool payloads first.
- Keep semantic tool calls behind a typed adapter module.
- If semantic fields are missing, show backend diagnostics; do not invent values.
