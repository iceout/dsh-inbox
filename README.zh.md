# dsh-inbox

[English](README.md) | 中文

一个 DeepSeek Harness（DSH）插件，用于“还不属于任何项目”的对话。

- **新对话**：侧栏按钮，创建一个没有工作区的真实会话。它出现在「未分组」里，工具照常可用（web search、读写文件），不会往项目列表里加东西。
- **立项**：讨论有结论后，让 agent「创建项目」。它写 `BRIEF.draft.md` 并调用 `project_propose`，对话里出现预览卡片。**由你**点「创建项目」，插件才会建目录、写 `BRIEF.md`（以及一行指向它的 `AGENTS.md`）、注册工作区，并在新工作区打开一个预填好但不自动发送 kickoff 的新会话。

旧对话不迁移、不复制，留在「未分组」，卡片变成「已创建 · 打开项目」。

> 状态：0.1.0，早期版本。见[兼容性](#兼容性)与[已知限制](#已知限制)。

## 安装

DSH 支持从 npm 或 Git 安装插件。从 Git 安装时固定 tag 或 commit：

```text
git+https://github.com/iceout/dsh-inbox.git#v0.1.0
```

然后在 profile 里启用 `dsh-inbox` bundle 并重启 DSH。

本地开发：在 profile 的 `package.json` 里加 `"dsh-inbox": "link:/path/to/dsh-inbox"`，并把 `"dsh-inbox"` 加进 `dsh.profile.bundles`。

## 配置

都是可选项，写在 profile 的 `cordis.patch.yml` 中 `dsh-inbox` 那一行：

| 键 | 默认值 | 含义 |
|---|---|---|
| `defaultProjectRoot` | `~/projects` | 已有工作区推断不出父目录时使用 |
| `writeAgentsPointer` | `true` | 写一行指向 `BRIEF.md` 的 `AGENTS.md`（DSH 自动读 `AGENTS.md`，不读 `BRIEF.md`） |

## 工作方式

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/inbox/<id>/` | Inbox 会话的 cwd，agent 在这里写草稿 |
| `$DSH_HOME/inbox-state/<sessionId>/` | 只有插件写：`meeting.json`、`proposals/<id>.json`（含快照和 hash）。不在任何会话的 cwd 里，`workspace-write` 沙箱下 agent 改不了 |

- 唯一对模型可见的工具 `project_propose` 不会碰项目路径。
- 只有点卡片按钮才会创建。写入的是你预览过的快照；预览后草稿被改过，就拒绝创建，要求先重新预览。
- 创建幂等且能从崩溃中恢复：先记录目标路径再写盘；文件用临时文件 + `fsync` + `link` 写入，绝不覆盖；重试时接管自己留下的半成品。
- 默认路径：对话里给出的路径 → 多数工作区共同的父目录 → 最新工作区的父目录 → `defaultProjectRoot`。卡片上始终显示绝对路径。

## 兼容性

`engines.dsh`：`>=0.2.1-rc.5 <0.3.0`，基于 0.2.2-rc.1 开发。只使用公开扩展点：`sidebar.footer.action`、`tool.call.toolview`、`connection.fetch`、`tools`、`skills`、`workspaceRegistry`、`sessionController`。

## 已知限制

- 在 `danger-full-access` 权限预设下，agent 可以写任何位置（包括插件状态）、也能自己建目录；“只有你能创建”的保证只在 `workspace-write` 下成立。
- 入口按钮在侧栏底部。放到原生「新会话」按钮旁需要 DOM 注入，暂未提供。
- Inbox 会话和提议只存在本机，不做同步。
- 旧的 Inbox 会议目录暂不自动清理。

## 开发

```sh
npm test        # node:test，不需要安装 DSH
npm run check   # 检查 package files、仓库内无绝对 home 路径
```

设计说明见 [docs/design.md](docs/design.md)。

## 许可证

MIT
