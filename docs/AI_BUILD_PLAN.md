# AI Build Plan

## Goal

Hook the chat panel up to a configurable LLM and route AI behavior through the semantic surface rather than parse layers.

The AI stack should be isolated in a separate crate where practical, while `mercurio-core` remains the source of semantic truth and `mercurio-application` remains the host that exposes workspace actions.

## Current State

- The chat UI is still a stub in `mercurio-application-ui/src/App.tsx`.
- The frontend already has an agent client in `mercurio-application-ui/src/app/agentClient.ts`.
- The backend already has provider adapters and an agent loop in `mercurio-application/src/commands/ai.rs`, but that command surface is not currently registered in the Tauri invoke handler.
- The backend already exposes semantic/model read tools through `mercurio-application/src/commands/tools.rs`.
- Semantic edit is implemented, but its current payload shape is UI-oriented and expects the frontend to assemble detailed target metadata.

## Architecture

### New crate: `mercurio-ai`

`mercurio-ai` should own:

- provider configuration and adapters
- chat and agent loop orchestration
- tool definitions and schemas
- request and response contracts for AI sessions
- multistep planning and execution state
- retry, truncation, and step logging behavior

`mercurio-ai` should not depend on Tauri.

### `mercurio-application`

`mercurio-application` should own:

- Tauri commands for chat and agent execution
- implementation of AI tool execution against workspace state
- bridging from UI requests into `mercurio-ai`
- confirmation and safety rules for mutating actions
- UI and command handling for resumable agent sessions

### `mercurio-core`

`mercurio-core` should own:

- semantic and model truth
- compile execution
- AI-facing semantic helper APIs where needed

The AI should consume app-facing semantic tools, not parse trees or raw AST pathways.

## Boundary Rules

- The AI should prefer semantic tools first.
- Parse and AST tools should not be exposed to the model by default.
- Workspace writes must stay scoped to the selected project root.
- Semantic edits should be addressed by stable semantic identity, not fragile UI state.
- Multistep agent execution must remain visible to the user through explicit plan and step state.
- Mutating multistep flows should stop for confirmation before broad or destructive changes.

## Target Tool Surface

### Read tools

- `core.get_workspace_startup_snapshot@v1`
- `core.get_workspace_symbol_snapshot@v1`
- `core.query_semantic_symbols@v1`
- `core.query_semantic_element@v2`
- `core.get_project_model@v1`
- `core.get_project_element_property_sections@v1`

### Action tools

- `workspace.compile_project@v1`
- `workspace.compile_file@v1`
- `semantic.resolve_target@v1`
- `semantic.list_actions@v1`
- `semantic.preview_edit@v1`
- `semantic.apply_edit@v1`

### Fallback tools

- `fs.read_file@v1`
- `fs.apply_patch@v1`
- `fs.write_file@v1`

Fallback filesystem tools are useful, but they should not be the default path when a semantic operation exists.

## Config Plan

AI configuration should move to backend-owned settings.

Store:

- active provider
- base URL
- provider type
- model
- tool enablement flags
- non-secret endpoint metadata

Prefer OS keychain storage for tokens. Do not rely on frontend local storage as the long-term source of truth for credentials.

## Session And Planning Plan

The first live agent loop is only a stepping stone. The target design should support resumable, visible multistep execution.

Add explicit session state for:

- user goal
- plan items and step status
- working notes and intermediate reasoning summaries
- tool execution history
- pending confirmations and blocked states
- final summary and follow-up suggestions

Add explicit agent actions for:

- `plan_create`
- `plan_update`
- `plan_mark_step`
- `ask_user`
- `continue`
- `final`

The UI should show:

- the current plan
- which step is in progress
- completed and failed steps
- pending approvals
- tool activity and latest results

The backend should allow a session to continue across multiple turns rather than forcing every request into a single short tool loop.

## Phases

### Phase 1. Extract AI runtime

- add `mercurio-ai` to the workspace
- move provider adapters and agent loop out of `mercurio-application/src/commands/ai.rs`
- define stable AI request, response, and tool contracts

### Phase 2. Activate backend AI commands

- register `ai_test_endpoint`
- register `ai_agent_run`
- register `list_tools`
- keep `call_tool` as the low-level bridge

Target result:

- the frontend can invoke a live agent path instead of a stub

### Phase 3. Wire the chat UI

- replace the stubbed chat behavior in `App.tsx`
- call the backend agent path
- show model replies, tool steps, errors, and cancellation state

Target result:

- the chat panel becomes a real assistant surface

### Phase 4. Add backend-owned AI settings

- extend app settings for AI endpoint metadata
- add token storage strategy
- add UI for selecting and testing providers

Target result:

- the LLM is configurable without code changes

### Phase 5. Add session-based multistep planning

- introduce backend `AgentSession` state
- support resumable execution across multiple user turns
- add explicit plan actions and step tracking
- surface plan state and pending confirmations in the UI

Target result:

- the assistant can plan, execute, pause, resume, and summarize multistep work

### Phase 6. Make semantic edit AI-friendly

- add backend target resolution from `qualified_name`, optional `file_path`, and optional `symbol_id`
- stop requiring the AI to construct the full UI-style semantic edit payload
- let the backend derive lineage and target metadata

Target result:

- the AI can request semantic edits by stable semantic identity

### Phase 7. Add compile and semantic action tools

- expose compile as first-class AI tools
- expose semantic edit list, preview, and apply as first-class AI tools
- compile after successful semantic edits and return diagnostics

Target result:

- the AI can inspect, edit, and validate the model end-to-end

### Phase 8. Pass useful workspace context

Each chat request should include:

- project root
- active file
- selected symbol qualified name
- latest compile summary
- unsaved editor buffers, or a clear save-before-agent policy

Target result:

- the AI reasons over current workspace state instead of stale disk state

### Phase 9. Test coverage

- provider adapter tests
- tool catalog contract tests
- agent session and plan transition tests
- semantic target resolution tests
- semantic preview/apply tests
- compile-after-edit integration tests
- Tauri command smoke tests

## Recommended First Sprint

1. Create `mercurio-ai`.
2. Move the current backend AI runtime into it.
3. Register the AI commands in Tauri.
4. Wire the existing frontend chat client to the live backend.
5. Add `list_tools`.
6. Add initial session state and plan display.
7. Add compile tools.
8. Add one semantic edit flow, starting with rename.

This delivers a useful assistant quickly while keeping the architecture pointed at semantic-first behavior.

## Exit Criteria

- Chat uses a configurable backend LLM.
- AI orchestration lives in a dedicated crate.
- The assistant supports visible multistep planning and resumable execution.
- The AI defaults to semantic/model tools rather than parse layers.
- The AI can compile, inspect the model, and perform at least one semantic edit flow.
- AI endpoint configuration is backend-owned.
- Workspace mutations are scoped, previewable, and test-covered.

## Notes

- The current backend already contains useful AI pieces, but they are partially disconnected from the active command surface.
- The existing semantic edit contract is a good implementation substrate, but it should not remain the direct AI-facing API.
- The first production-safe version should favor semantic actions plus explicit fallback file edits rather than unrestricted autonomous patching.
