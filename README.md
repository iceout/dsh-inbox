# dsh-inbox

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin for conversations that don't belong to a project yet.

- **New chat** — a sidebar button that starts a real session that ends up in no workspace. Tools stay on (web search, files). While the chat is still empty it sits in a temporary workspace titled *新对话* (DSH disables the composer of an empty session that has no workspace); on the first message that temporary registration is removed and the chat moves to *Ungrouped*. An unused empty chat is reused by the next click.
- **Turn it into a project** — when the discussion has converged, ask the agent to "create a project". It writes `BRIEF.draft.md` and calls `project_propose`; a preview card appears in the conversation. **You** click *Create project*; the plugin creates the directory, writes `BRIEF.md` (plus a one-line `AGENTS.md` pointer), registers the workspace and opens a new session there with a prefilled — not sent — kickoff message.

The old conversation is never moved or copied. It stays in *Ungrouped*, and its card turns into *Created · Open project*.

> Status: 0.1.0, early. See [Compatibility](#compatibility) and [Known limitations](#known-limitations).

## Install

DSH installs plugins from npm or Git. From Git, pin a tag or commit:

```text
git+https://github.com/iceout/dsh-inbox.git#v0.1.0
```

Then enable the bundle `dsh-inbox` in your profile and restart DSH.

For local development, link the checkout into your profile's `package.json` (`"dsh-inbox": "link:/path/to/dsh-inbox"`) and add `"dsh-inbox"` to `dsh.profile.bundles`.

## Configuration

All optional, in the profile's `cordis.patch.yml` row for `dsh-inbox`:

| Key | Default | Meaning |
|---|---|---|
| `defaultProjectRoot` | `~/projects` | Parent folder used when no existing workspace suggests one |
| `inboxTitle` | `新对话` | Title of the temporary workspace shown while a new chat is still empty |
| `writeAgentsPointer` | `true` | Write a one-line `AGENTS.md` pointing at `BRIEF.md` (DSH reads `AGENTS.md` automatically, not `BRIEF.md`) |

## How it works

| Where | What |
|---|---|
| `$DSH_HOME/inbox/<id>/` | Inbox session cwd. The agent writes drafts here. |
| `$DSH_HOME/inbox-state/<sessionId>/` | Plugin-only state: `meeting.json`, `proposals/<id>.json` with snapshots and hashes. Not inside any session cwd, so the `workspace-write` sandbox keeps the agent out. |

- The only model-visible tool, `project_propose`, never touches the project path.
- Creation happens only through the card's button. What gets written is the snapshot you previewed; if a draft changes after the preview, creation is refused until you re-preview.
- Creation is idempotent and crash-safe: the intended path is recorded before any write, files are written via temp file + `fsync` + `link` (never overwriting), and a retry adopts its own partial result.
- Default path: an explicit path from the conversation, else the folder most of your workspaces share, else the parent of your newest workspace, else `defaultProjectRoot`. The card always shows the absolute path.

## Compatibility

`engines.dsh`: `>=0.2.1-rc.5 <0.3.0`. Built against 0.2.2-rc.1. Uses public extension points only: `sidebar.footer.action`, `tool.call.toolview`, `connection.fetch`, `tools`, `skills`, `workspaceRegistry`, `sessionController`.

## Known limitations

- Under the `danger-full-access` permission preset the agent can write anywhere (including plugin state) and create directories itself; the "only you can create" guarantee holds under `workspace-write`.
- The entry button lives in the sidebar footer. A button next to the native "New session" button needs DOM injection and is not shipped yet.
- Inbox sessions and proposals are local to each machine; nothing is synced.
- Old Inbox meeting directories are not cleaned up automatically yet.

## Development

```sh
npm test        # node:test, no DSH needed
npm run check   # package files + no absolute home paths
```

Design notes: [docs/design.md](docs/design.md).

## License

MIT
