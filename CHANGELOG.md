# Changelog

## 0.1.0 — unreleased

- Sidebar footer entry "New chat" creates a workspace-less Inbox session in `$DSH_HOME/inbox/<id>/`.
- `project_propose` tool: validates the target path, snapshots `BRIEF.draft.md` (and optional `AGENTS.draft.md`) into plugin state under `$DSH_HOME/inbox-state/`.
- Proposal card in the conversation: preview, Create / Modify / Re-preview / Continue / Open project.
- Crash-safe, idempotent creation (intent recorded first, adoption of own partial results, no-overwrite writes).
- Bundled `inbox-project-kickoff` skill with the brief checklist.
