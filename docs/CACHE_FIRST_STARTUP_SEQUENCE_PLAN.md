# Cache-First Startup Sequence Plan

## Goal

Improve perceived startup speed by changing the project-open sequence:

1. load current project and library file trees from the live filesystem first
2. render those trees immediately
3. load cached symbols and semantic state second
4. reconcile live symbol state last

The main optimization target is first visible feedback in the UI, not maximum cache reuse.

## New Startup Contract

### Desired behavior

When a project opens, the UI should:

- show the current Project Files tree from disk as quickly as possible
- show the current Library Files tree from disk as quickly as possible
- preserve tree expansion, selection, tabs, and scroll position during later updates
- apply cached symbol and semantic overlays after the tree is already visible
- reconcile live symbol state in the background without resetting navigation

### Explicit ordering

#### Phase 1. Live tree hydration

- fetch live project tree
- resolve active library path
- fetch live library tree
- render both trees immediately

This phase must not wait on symbol cache parsing.

#### Phase 2. Cached symbol hydration

- load cached project symbols
- load cached library symbols
- seed semantic/property-backed data from cache
- patch tree counts and symbol subtrees in place

This phase is allowed to be briefly stale, but it should not block tree visibility.

#### Phase 3. Live reconcile

- refresh project/library symbols from the backend
- update semantic state
- patch only changed tree/symbol regions

This phase must not collapse trees or interrupt open tabs.

## Why Change the Current Design

The current startup snapshot path optimizes for one backend fetch, but it can still delay first paint when:

- the persisted cache file is large
- JSON parse time becomes noticeable
- symbol payload size dominates startup cost

For perceived responsiveness, live filesystem tree data is the cheapest high-value first paint. Users can navigate folders before semantic decoration is ready.

## Ownership

### UI owns

- startup sequencing
- tree rendering
- non-interruptive patch application
- expansion/selection/tab/scroll preservation

### `mercurio-core` owns

- live project tree query
- live library tree query
- cached symbol snapshot
- semantic seed/reconcile behavior
- cache persistence format

## API Changes

### Add a live tree startup endpoint

Add a core-owned endpoint dedicated to fast tree hydration.

Suggested DTO:

- `project_tree`
- `library_tree`
- `library_path`
- `diagnostics`

This endpoint should read the filesystem directly and avoid loading large symbol payloads.

### Keep cached symbol startup separate

Use a separate endpoint for cached symbol startup hydration.

Suggested DTO:

- `project_symbols`
- `library_symbols`
- `library_path`
- `cache_hit`
- `diagnostics`

This endpoint should be allowed to seed semantic lookup from persisted cache without also carrying tree manifests.

### Keep live symbol reconcile separate

Retain the existing post-startup/live symbol refresh path as a later phase.

## Cache Format Changes

### Problem

The current cache is persisted as one JSON file. For large workspaces that creates an avoidable startup tax:

- full-file read
- full JSON parse
- full in-memory materialization before symbols can be used

### Recommended direction

Split cache by concern.

#### Small startup manifest

Persist a small manifest for fast startup metadata only:

- library path
- cache version
- timestamps / generation metadata

This can remain JSON.

#### Tree cache

Persist tree manifests separately from symbols.

Options:

- keep as small JSON if tree size is modest
- or use a compact binary encoding if tree payloads also grow

#### Symbol cache

Move large symbol and semantic payloads out of JSON.

Preferred options:

1. `bincode`
2. `postcard`
3. MessagePack / `rmp-serde`

The goal is faster decode and smaller files, not human readability.

### Non-goals

- caching editor file contents
- making startup fully offline from the filesystem
- removing live reconcile

## UI Refactor Steps

### Step 1. Split startup orchestration in `App.tsx`

Replace the current single startup snapshot flow with:

- `loadLiveWorkspaceTrees(rootPath)`
- `loadCachedWorkspaceSymbols(rootPath)`
- `reconcileWorkspaceSymbols(rootPath)`

### Step 2. Keep manifest-backed trees

Retain the current manifest-based tree model, but change the source of truth:

- live tree endpoint for initial population
- watcher/reconcile patching afterwards

### Step 3. Patch symbols onto existing trees

Do not rebuild tree state when cached symbols arrive.

Instead:

- update symbol maps
- update per-file symbol counts
- update expandable symbol sections

### Step 4. Preserve navigation on removals

If a live tree refresh removes a file:

- remove it from the tree
- clear tree selection only if needed
- keep open tabs intact until the user closes them or reload fails

## Core Refactor Steps

### Step 1. Add fast live tree endpoints

Expose tree-only calls from `mercurio-core` and route them through `mercurio-application`.

### Step 2. Split persisted cache files

Move from one large workspace IR JSON file toward:

- startup manifest
- tree cache
- symbol cache
- semantic projection cache

### Step 3. Add binary symbol cache

Persist large symbol and semantic payloads in a compact binary format.

### Step 4. Keep global cache clear semantics

Global cache clear should remove all of the above cache files and tracked roots.

## Suggested File Targets

### Core

- `mercurio-core/src/workspace_tree.rs`
- `mercurio-core/src/workspace_ir_cache.rs`
- `mercurio-core/src/workspace_symbols.rs`
- `mercurio-core/src/state.rs`

### Application bridge

- `mercurio-application/src/commands/tools.rs`
- `mercurio-application/src/lib.rs`

### UI

- `mercurio-application-ui/src/App.tsx`
- `mercurio-application-ui/src/app/useProjectTree.tsx`
- `mercurio-application-ui/src/app/useSymbolRefreshController.tsx`
- `mercurio-application-ui/src/app/services/semanticApi.ts`
- `mercurio-application-ui/scripts/generate-core-contracts.mjs`

## Validation Plan

### Rust

- `cargo check --workspace --all-targets`
- `cargo test -q -p mercurio-core`

Add tests for:

- live tree endpoint returns current filesystem state
- cached symbol startup works when tree load is already complete
- split cache files round-trip correctly
- global cache clear removes all startup/symbol cache artifacts

### UI

- `npm run generate:core-contracts --prefix mercurio-application-ui`
- `npm run build --prefix mercurio-application-ui`

Manual checks:

- project tree appears before symbols
- library tree appears before symbols
- cached symbols decorate existing tree without reset
- watcher updates do not collapse expanded folders
- compile/library refresh does not reset navigation

## Exit Criteria

- project and library trees render from live filesystem data before cached symbols are parsed
- cached symbols no longer gate first tree paint
- symbol cache is split from tree startup data
- large symbol cache parsing cost is reduced materially versus the current JSON path
- tree updates remain non-interruptive

## Recommended Sequence

1. add live tree startup endpoints and UI-first sequencing
2. separate cached symbol startup from tree startup
3. split cache files by concern
4. move large symbol cache payloads to binary
5. measure startup timings before and after
