# Changelog

## 0.1.0 — unreleased

- Sidebar footer entry "New chat" creates an Inbox session in `$DSH_HOME/inbox/<id>/`. It starts in a temporary workspace (DSH disables the composer of a blank, workspace-less session) and moves to Ungrouped on its first turn; a still-blank one is reused.
- `project_propose` tool: validates the target path, snapshots `BRIEF.draft.md` (and optional `AGENTS.draft.md`) into plugin state under `$DSH_HOME/inbox-state/`.
- Proposal card in the conversation: preview, Create / Modify / Re-preview / Continue / Open project.
- Crash-safe, idempotent creation (intent recorded first, adoption of own partial results, no-overwrite writes).
- Bundled `inbox-project-kickoff` skill with the brief checklist.
