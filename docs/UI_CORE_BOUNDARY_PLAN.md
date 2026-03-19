# UI/Core Boundary Plan

## Goal

Move semantic truth, symbol identity, and model interpretation out of the React UI.

The UI should render backend-owned data, not reconstruct it.

## Boundary Rules

- UI owns presentation, local interaction state, and request orchestration.
- `mercurio-core` owns app-facing tool payloads, symbol refresh behavior, and display-ready semantic views.
- The core `mercurio-sysml` repo should own semantic/model contract definitions that are not application-specific.

## Current Problems

### 1. Property pane reconciliation is in React

`CombinedPropertiesPane.tsx` currently:

- matches semantic features to inherited metatype attributes
- infers fallback matches by normalized names and suffixes
- decides which rows are "Additional Semantics"
- formats domain-specific expression labels

This is semantic interpretation logic, not view logic.

### 2. Symbol identity and merge rules are in the UI

`compileShared.ts` and `useSymbolRefreshController.tsx` currently:

- define symbol dedupe keys
- normalize file paths for symbol identity
- decide how compile results replace indexed state
- retry and hydrate library/project symbol state based on inferred expectations

This is index/snapshot ownership leaking into the UI.

### 3. Type contracts are duplicated in TypeScript

`types.ts` hand-maintains structures for:

- symbols
- semantic values and features
- project model views
- project element attributes

These should not drift independently from Rust.

### 4. The UI parses backend error strings

`parseErrors.ts` extracts line/column data from formatted text. The backend should return structured diagnostics instead.

### 5. Path semantics are duplicated

Path normalization rules exist in multiple UI files. If path identity matters to symbol/index behavior, the backend must own the canonical rules.

## Ownership Targets

### Keep in UI

- pane layout, tree expansion, tabs, filters, sort order
- compile debounce and queue UX
- formatting already-resolved values for display
- click/selection/navigation behavior

### Move to `mercurio-core`

- display-ready property rows for a selected element
- symbol snapshot and diff APIs
- structured parse and semantic diagnostics
- normalized path handling used by tool responses
- compile response contracts that eliminate UI-side merge heuristics

### Move to the core `mercurio-sysml` repo

- canonical semantic/model contract definitions
- shared semantic projection/view schemas when they are not app-specific
- generated contract source used by `mercurio-core` and the UI

`mercurio-sysml` should define the shape of semantic truth.

`mercurio-core` should package that truth into application tools.

## Proposed Workstreams

### Workstream 1. Replace property-pane inference

Add a backend tool that returns display-ready property sections for an element, including:

- resolved metatype
- direct and inherited metatype attributes
- matched explicit values
- unmatched semantic features
- expression rows
- diagnostics

Target result:

- `CombinedPropertiesPane.tsx` becomes a pure renderer.
- No string-based semantic feature matching remains in UI code.

### Workstream 2. Replace UI-side symbol merge logic

Add backend-owned symbol refresh contracts:

- full project snapshot endpoint, or
- explicit delta endpoint keyed by compile result

Target result:

- remove `mergeSymbols`
- remove `mergeProjectSymbolsByFile`
- remove `mergeProjectSymbolsByParsedFiles`
- stop treating the UI as a partial symbol store

### Workstream 3. Generate shared contracts

Introduce one source of truth for semantic and model payloads.

Options:

1. Generate TypeScript types from Rust `serde` models.
2. Generate both sides from a schema owned by the core `mercurio-sysml` repo.

Target result:

- `types.ts` stops hand-owning backend contract shapes.
- contract drift becomes a build-time failure.

### Workstream 4. Return structured diagnostics

Replace string parsing with structured backend payloads:

- parse diagnostics with `file`, `line`, `column`, `message`, `category`
- semantic diagnostics with stable fields, not display strings

Target result:

- remove `parseErrors.ts`
- stop regex-parsing backend messages in UI code

### Workstream 5. Collapse path normalization into one authority

Choose one backend-compatible normalization strategy and expose it through tool payload behavior.

Target result:

- UI path helpers become minimal or disappear
- path equality and containment no longer differ by feature

## Suggested Sequence

### Phase 1. Contract cleanup

- add structured diagnostics
- define generated/shared types
- document the allowed UI/backend boundary

### Phase 2. Property panel migration

- add a backend property-sections tool
- replace semantic reconciliation in `CombinedPropertiesPane.tsx`

### Phase 3. Symbol refresh migration

- add snapshot or diff endpoints
- remove UI dedupe and merge ownership

### Phase 4. Path cleanup

- centralize path normalization
- delete redundant UI helpers

## Exit Criteria

- UI does not infer semantic matches from names or suffixes.
- UI does not decide symbol identity or merge rules.
- UI does not parse backend display strings for structure.
- semantic/model payload types are generated or shared from one source.
- React components render backend-prepared views instead of reconstructing them.

## Notes

- Not every Rust-side view belongs in the core `mercurio-sysml` repo. Application-facing aggregation belongs in `mercurio-core`.
- The dividing line is simple:

If a rule affects semantic truth, symbol identity, inheritance meaning, or model interpretation, it should not live in the UI.
