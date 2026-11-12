# dsh-inbox 设计稿（「新对话 → 创建项目」）

> 状态：设计稿 r4（已吸收三轮 review），未开始实现。
> 日期：2026-11-12。
> 目标读者：后续实现者、review。
> 工作名：`dsh-inbox`（暂定；入口文案为「新对话」）。
> 对照源码：`deepseek-harness` @ 0.2.2-rc.1（`66491b05e3`）。

---

## 0. 一句话

一个自包含的 DSH 插件：加一个「新对话」入口，创建**不属于任何项目工作区**的 Inbox session；讨论结束后，agent 写 `BRIEF.draft.md` 并调用 `project_propose`（只写会议目录、不产生会议目录外副作用），插件在对话里渲染一张**预览卡片**；用户在卡片上**亲手点「创建项目」**，插件创建目录、注册工作区、写入 `BRIEF.md`，并在新工作区打开一个**预填 kickoff 但不自动发送**的新 session。旧 session 不迁移、不复制，留在 Inbox，卡片变为「已创建 · 打开项目」。

---

## 0.1 产品决策（基线）

| 决策 | 内容 |
|---|---|
| 形态 | 单插件、自包含；零第三方运行时依赖；不依赖 projectless / mover / session-manager / chat-mode |
| 分发 | **在 GitHub 公开仓库开源**（独立仓库，MIT），其他开发机通过 git 安装；见 §15 |
| 入口 | 「新对话」；一个入口，不区分“快速问 / 会议”。位置：保底 `sidebar.footer.action`，增强为原生「新会话」按钮旁（DOM 注入，可关闭），见 §5.1 |
| Inbox | 真实 session，无项目工作区，cwd 为 `$DSH_HOME/inbox/<dirId>/`（插件状态另存于 `$DSH_HOME/inbox-state/`，agent 不可写）；工具默认开；留在 Ungrouped 可回查 |
| 出口 | 「立项」：agent 写草稿并 propose → 卡片预览 → **用户点击按钮**创建 |
| 确认 | **由人点击卡片按钮完成**，不依赖模型调用 `ask_user_question`，也不依赖会话审批策略；模型拿不到任何有副作用的创建工具 |
| 交接 | 不迁移/不复制 session；只写 `BRIEF.md` + 短 kickoff；旧 session 留 Inbox |
| 草稿 | `BRIEF.draft.md` 在会议目录；propose 时快照；创建时若草稿已与快照不一致则拒绝并要求重新预览，保证写入内容 = 用户看到并确认的内容 |
| Brief | 核心 checklist + 可选节；不固定 schema；软校验只给 warning；不自动生成代码脚手架；写作指南放在 skill 里 |
| AGENTS | 默认只写**一行指针**（“项目背景与已定决策见 BRIEF.md”）；只有跨 session 长期规则才写更多 |
| 工具 | 默认开；web search 可用；不做 chat/work 切换；`project_propose` 仅在 Inbox session 中可用 |
| 路径 | 优先用户显式路径；否则由 **host** 按规则推断；卡片始终显示绝对路径 |
| 新 session | 新工作区里打开；kickoff 预填、手动发送；接受短暂停止/重载 |
| 旧 session | 留在 Ungrouped；不自动归档/改标题；会话里的卡片即“已创建项目”标记；`BRIEF.md` 里放来源标题/id |

### 0.2 r2 修订记录（相对 r1）

| 变更 | 原因 |
|---|---|
| 删除模型可调的 `project_create`，改为卡片按钮 → host 路由创建 | r1 的确认依赖模型自觉调用 `ask_user_question`，proposalId 无法证明用户同意；原生工具审批（`tools/pre-execute` → `ask`）在 `danger-full-access`（审批策略 `never`）下恒为 rejected，在 `auto` 下由审阅模型放行，不可靠 |
| 删除 pending-open 存储、`GET /pending`、ack、轮询 | 创建与打开发生在同一次用户点击中，客户端拿到 workspaceId 直接 `startSession`，无需 host→client 推送 |
| 删除 `project_cancel` | 同一 session 新 propose 自动作废旧 proposal |
| proposal 落盘 + draft 快照 + 状态机 | 人点按钮的时间不可控（可能跨 host 重启）；保证卡片预览 = 写入内容；支持幂等重试 |
| 删除 `sidebar.workspaces` 回退 | 该 slot 是 `single` 且由 ui-workspace 占用（`ui-sidebar/src/client/index.ts:90`），注册即抢占整个工作区列表 |
| `BRIEF.md` 写入改为 `wx` / `link`，不用 tmp+rename | rename 会静默覆盖已存在目标，违背“不覆盖” |
| 路径推断移到 host | 确定性、可单测，不靠模型猜 |
| Brief 指南移到 skill；工具描述精简 | 工具描述每轮占 token |
| AGENTS 默认写一行指针 | DSH 自动读 `AGENTS.md`、不读 `BRIEF.md`；否则项目第 2+ 个 session 不知道 brief |
| 会议目录用 sessionId 命名 | `SessionCreateRequest.sessionId` 允许调用方指定身份；目录 ↔ session 一一对应 |
| 新增 §15 开源与多机分发 | 插件在 GitHub 公开仓库开源，供多台机器安装 |

r3（第二轮 review）：

| 变更 | 原因 |
|---|---|
| create 重试可“接管”已注册的 workspace（§7.3） | r2 中第 7 步注册成功、第 8 步写状态前崩溃，重试会被“已注册 → 拒绝”永久卡住 |
| 路由改为 `/api/inbox/sessions/:sessionId/proposals/:proposalId`，严格校验 id 格式与归属（§7.2） | r2 只有 proposalId，无法定位文件、无法校验归属，且有路径穿越风险 |
| 草稿在 propose 后被修改 → create 返回 409 `draft-changed`，卡片提供「按当前草稿重新预览」（§3.1） | r2 只提示不阻断，用户改了草稿再点创建会静默写入旧版本，违背所见即所得 |
| `project_propose` 表述改为“无会议目录外副作用”，不再称“只读” | 它会写 proposal 文件与快照 |
| 记录项目首个 session 的 id，「打开项目」优先 `openSession` 回到它（§5.2） | r2 每次点「打开项目」都走 `startSession`，可能重复新建 kickoff session |
| 客户端注入加 `conversation`，「修改」用 `SessionInput.setDraft` 预填（§8.2） | r2 未列出预填输入框依赖的服务 |
| 放弃 `sidebar.panellist` 候选 | 源码确认它是“全局面板图标”列表，每个 id 对应一个主面板，点击语义是选中面板，不是动作（`ui-sidebar/src/client/contract/slots.ts:32-36`） |
| 路径校验加强：最终目标 lstat、创建后 realpath 复核（§9.3） | r2 只 realpath 最近已存在祖先，最终目标为符号链接或被并发替换时可能逃逸 |
| Phase 0 改为“验证门槛”，每项写明通过标准与失败退路（§12） | 若干 API 假设决定架构，必须在写正式功能前得出结论 |

r4（第三轮 review）：

| 变更 | 原因 |
|---|---|
| proposal 状态与快照移出 agent 可写的 cwd，放到 `$DSH_HOME/inbox-state/<sessionId>/`（§3、§10） | 威胁模型包含网页内容 prompt injection（web search 默认开）；`workspace-write` 沙箱只允许写 cwd，状态放在 cwd 内等于让 agent 能改“用户确认过的内容” |
| 接管条件改为“目标目录内容 ⊆ 本 proposal 的产物”，空目录也算（§7.3） | r3 要求 `BRIEF.md` 存在且 hash 一致，mkdir 后、写文件前崩溃会留下空目录，重试被 EEXIST 卡死 |
| repropose 原地更新同一 proposalId（`revision` 递增） | r3 生成新 id，刷新后旧卡片只能看到 superseded，新 proposal 没有卡片可点 |
| 快照 hash 覆盖 `{brief, agents}` 两部分 | r3 只比对 `BRIEF.draft.md`，`AGENTS.draft.md` 变更会被静默写入旧版本 |
| 项目文件统一用“临时文件 + fsync + link”写入，接管时清理本 proposal 的临时文件 | r3 允许直接 `writeFile wx`，写到一半崩溃留下残缺 `BRIEF.md`，hash 不符且目录非空，重试卡死 |
| `POST /session` 不再重命名会议目录；会议目录与 session 的对应关系记录在状态目录 | session header 的 cwd 不可变，重命名目录会让 session cwd 失效 |

---

## 1. 背景与要解决的问题

用户有两类对话需求：

1. **简单问答**：查资料、问一句，事后很少回看；不希望为它建项目工作区、不希望污染项目列表。
2. **项目孵化**：需求还没想清楚，先和 agent 讨论；聊出结论后，希望 agent 直接创建工作区、生成项目说明，并开始项目开发；不想自己手动建目录、写说明。

共同点：

- session 存在是好的（以后可能回查），所以不需要 `clean-chat` 那种“零会话文件”面板。
- 但 session 一开始**不应属于任何项目工作区**，也不应出现在项目列表里。
- 讨论历史不必完整复制到新项目；真正需要交接的是**结论、范围、约束、未决问题、下一步**。
- 工具默认开启（需要 web search、读文件、写文件等）。
- 接受创建项目时的短暂停止/重载。

---

## 2. 目标 / 非目标

### 2.1 目标

- 一个入口「新对话」：创建无项目工作区的 Inbox session。
- 一个出口「立项」：agent 草拟 + propose → 卡片预览 → 用户点击创建 → 新工作区里打开新 session，kickoff 预填、手动发送。
- 创建动作只能由用户点击触发；模型无法直接在 sandbox 外建目录/注册工作区。
- 不迁移 session、不复制讨论历史；旧 session 留在 Inbox 可回查。
- 单插件、零第三方运行时依赖。
- 项目类型无关：不假设软件开发，不自动生成代码脚手架。
- 公开开源、可在任意机器安装：代码与默认配置不含任何个人路径/账号/私有信息，行为只依赖 DSH 公开扩展点与可配置项。

### 2.2 非目标（明确不做）

- 不做完整聊天客户端；不重写 DSH 会话 UI。
- 不做 session 迁移/历史复制/header 重写。
- 不做固定 brief 模板 schema；不强制 section。
- 不自动 `git init`、不生成 `package.json`/README/测试。
- 不做独立弹窗（确认在对话内卡片中完成）。
- 不做 Inbox 专用列表/标签/自动归档（v1；用原生 Ungrouped）。
- 不做工具开关/chat-work 模式切换。
- 不依赖任何第三方 DSH 插件。
- 不做多用户/团队协作。

---

## 3. 概念模型

| 概念 | 定义 |
|---|---|
| **Inbox session** | 一个真实 DSH session，没有 workspace，cwd 为插件管理的会议目录；侧栏显示在 Ungrouped；工具正常可用 |
| **会议目录** | `$DSH_HOME/inbox/<dirId>/`（`dirId` 通常等于 sessionId）；Inbox session 的 cwd，也是 `workspace-write` 下 agent 唯一可写处；只存放 agent 写的草稿（`BRIEF.draft.md`、`AGENTS.draft.md`） |
| **状态目录** | `$DSH_HOME/inbox-state/<sessionId>/`（`0700`）；只由插件 host 写，不在任何 session 的 cwd 内；存放 `meeting.json`（`{ sessionId, cwd }`）与 `proposals/<proposalId>.json` |
| **Brief** | 交接文档，最终写入新工作区的 `BRIEF.md`；不要求固定 schema，但建议覆盖核心 checklist |
| **Proposal** | `project_propose` 生成的落盘记录：`{id, sessionId, revision, title, path, kickoff, writeAgents, snapshot{brief, agents?}, hash{brief, agents?}, warnings, state, intent?, workspaceId?, projectSessionId?}`；文件位于状态目录 `proposals/<proposalId>.json` |
| **Proposal 卡片** | 插件为 `project_propose` 注册的 `tool.call.toolview` 视图；渲染预览与按钮；状态随 proposal 变化 |
| **Create** | 用户点击卡片「创建项目」→ `POST /api/inbox/sessions/:sessionId/proposals/:proposalId/create`：mkdir、写 `BRIEF.md`/`AGENTS.md`、注册 workspace；幂等，可接管半途完成的状态 |
| **Old session** | 原始 Inbox 讨论 session；不迁移、不复制，保持在 Ungrouped；其中的卡片即“已创建项目”标记 |

### 3.1 Proposal 状态机

```
proposed ──点击创建──▶ creating ──成功──▶ created
   │                     │
   │                     └─失败──▶ failed ──点击重试──▶ creating
   ├─同 session 新 propose──▶ superseded
   └─点击创建时任一草稿 hash ≠ 快照 hash──▶ 409 draft-changed（状态保持 proposed）
                                              卡片：「草稿已修改」+ [按当前草稿重新预览]
                                              重新预览 = host 原地更新同一 proposal：重读草稿、
                                              替换 snapshot/hash、revision+1，state 回到 proposed
```

- `created` / `superseded` 为终态；对终态重复调用 create：`created` 返回原结果，`superseded` 返回 409。
- “草稿 hash”指 `BRIEF.draft.md` 与（`agents: "draft"` 时）`AGENTS.draft.md` 两者；任一变化都算修改。
- 卡片挂载时也会比对草稿 hash，提前显示「草稿已修改」，不必等点击才发现。
- repropose 不改 proposalId，所以卡片（以 tool call 里的 proposalId 为键）刷新后仍显示最新 revision 并可创建。只有 agent 重新调用 `project_propose` 才会生成新 id、并把旧 proposal 标为 `superseded`（新 proposal 自有新卡片）。
- `failed` 重试时同样先比对草稿 hash；但若已进入接管（意图已落盘，见 §7.3），以快照为准，不再比对草稿。
- 状态与结果写在状态目录 `proposals/<proposalId>.json`，host 重启后卡片仍能正确显示。

---

## 4. 用户流程

### 4.1 简单问答

```
点击「新对话」
  → POST /api/inbox/session：host 生成 sessionId、mkdir 会议目录、create({ cwd, sessionId })
  → uiWorkspace.openSession(sessionId)，工具可用
  → 用户问、agent 答（可 web search/读文件）
  → 用户离开；session 留在 Ungrouped，可搜索/回查
  → 不创建项目
```

### 4.2 项目孵化

```
Inbox session 中讨论
  → 用户说「立项」/「创建项目」/「把这次讨论变成项目」（或点标题栏按钮，Phase 2）
  → agent 加载「立项」skill（brief 指南 + 流程）
  → agent 写 BRIEF.draft.md 到会议目录
  → agent 调 project_propose({ title, path?, kickoff, agents? })
       host：推断/校验路径、软校验 brief、快照 draft、落盘 proposal
  → 对话中出现 Proposal 卡片：
       项目名 / 绝对路径 / 将创建的文件 / brief 摘要（可展开全文）/ kickoff / warnings
       [创建项目]  [修改]
  → agent 本轮结束，提示用户在卡片上确认（不再自行调用其它工具）
       ├─ 修改：用户点「修改」（预填一句“我想修改：”到输入框）或直接编辑 BRIEF.draft.md / 回复修改点
       │        → agent 更新草稿并重新 propose；旧卡片变为 superseded
       └─ 创建：用户点「创建项目」
            → POST /api/inbox/sessions/:sessionId/proposals/:proposalId/create
            → host：比对草稿 hash → mkdir → 写 BRIEF.md（快照）→ 可选写 AGENTS.md → workspaceRegistry.create → state=created
            → client：等待 workspaces.list 出现该 workspaceId → startSession(workspaceId, { prompt: kickoff, whenDraftExists: 'replace' })
            → client：从 workspaces.list 读到该 workspace 的首个 sessionId → POST …/opened 记录 projectSessionId
  → 用户检查/修改 kickoff，手动发送，开始项目
  → 旧 session 留在 Ungrouped；卡片显示「已创建 · 打开项目」；draft 与 proposal 保留
```

### 4.3 取消/失败

- 用户不点创建 → 什么也不发生；proposal 留在 `proposed`，卡片一直可点（创建时重新校验）。
- 路径冲突（已存在非空、已注册 workspace、落在禁止区域）→ propose 直接返回错误给 agent，agent 换路径重提，不出现可点卡片。
- propose 后、点击前路径状态变化 → create 时重新校验失败 → `failed`，卡片显示原因与「重试」；不覆盖、不删除。
- 创建中途失败 → 状态 `failed`，已完成步骤保留；重试时按幂等规则继续（§7.3）。
- 点击创建时草稿已修改 → 409 `draft-changed`，卡片提供「按当前草稿重新预览」；不会静默写入旧快照。
- 打开新 session 失败（列表同步超时等）→ 卡片显示「已创建 · 打开项目」按钮，用户可手动点；不影响创建结果。

---

## 5. UI 设计

### 5.1 入口：「新对话」

- 展开侧栏：图标 + 文案「新对话」；窄轨道：仅图标 + `title`/`aria-label`「新对话（不建项目）」。
- 点击：`POST /api/inbox/session` → `uiWorkspace.openSession(sessionId)`。
- 防重复：请求中禁用按钮；失败 toast。

位置方案（源码事实：原生新会话按钮无 slot，见 `ui-sidebar/src/client/SidebarRoot.tsx:342-372`）：

| 方案 | 说明 | 结论 |
|---|---|---|
| `sidebar.footer.action` | 官方 list slot，稳定；位置在底部 | **v1 保底，必做** |
| 原生「新会话」按钮旁 DOM 注入 | 新会话按钮出现在三处：宽栏 brand 按钮、`css.newSession` 按钮、macOS 收起时的 `shell.leading`；可用选择器只有随语言变化的 `aria-label`，CSS module 类名哈希化 | **增强，设置项可关闭**；找不到锚点时静默不注入，只保留 footer 入口 |
| ~~`sidebar.panellist`~~ | “全局面板图标”列表，每个 id 对应一个主面板，点击即选中面板（`ui-sidebar/src/client/contract/slots.ts:32-36`）；用作动作入口需伪造一个面板 | **放弃** |
| ~~`sidebar.workspaces`~~ | `single` 且由 ui-workspace 占用，注册会抢占工作区列表 | **禁止使用** |

### 5.2 出口：Proposal 卡片

- 通过 `ctx.slots.inject('tool.call.toolview', …)` 以 key `project_propose` 注册（`packages/client/ui-tool/README.md:36-48`）。
- 卡片数据来源：tool result 的结构化值含 `proposalId` 与摘要；`sessionId` 取自 session 作用域 slot 的标准 props（`tool.call.toolview` 的 scope 为 `session`，`ui-tool/src/client/contract/slots.ts:23-26`）。卡片挂载时 `GET /api/inbox/sessions/:sessionId/proposals/:proposalId` 读取最新状态（支持回放与 host 重启）。
- 卡片组件通过插件 `apply` 闭包访问 `uiWorkspace`、`workspaces`、`conversation`（registration `inject` 工厂返回所需回调），不依赖 owner props 提供这些服务。
- 各状态展示：

| 状态 | 展示 |
|---|---|
| `proposed` | 预览 + [创建项目] [修改] |
| `proposed` + 草稿已修改 | 「草稿已在预览后修改」+ [按当前草稿重新预览] [修改]；不提供直接创建 |
| `creating`（host 正持有该 proposal 的锁） | 进度/禁用按钮 |
| `creating` 但无锁（`interrupted: true`，上次创建被崩溃中断） | 「上次创建被中断」+ [继续创建]（调用 create，走接管流程） |
| `created` | 「已创建：<title> · <path>」+ [打开项目] |
| `failed` | 错误原因 + [重试] [修改] |
| `superseded` | 折叠显示「已被新提议替代」 |
| 读取失败（proposal 文件丢失） | 退回 tool result 文本摘要，无按钮 |

- 「修改」：`conversation.input.for(<该 session 的 ctx>).setDraft('我想修改：')`（`ui-conversation/src/client/contract/input.ts:183-189`）；拿 session 级 input 的具体方式列入 Phase 0。拿不到时退化为复制文案到剪贴板 + toast。
- 「打开项目」语义（按顺序）：
  1. 有 `projectSessionId` 且该 session 存在、未归档 → `uiWorkspace.openSession(projectSessionId)`，回到首次创建的项目会话；
  2. 否则 workspace 仍存在 → `startSession(workspaceId)`（不带 prompt）：由 DSH 复用该工作区的空白 session 或新建一个；kickoff 已用过，不再预填；
  3. workspace 已被删除 → 提示，并显示路径。
- 只有创建成功后的首次自动打开带 kickoff；之后不会再产生带 kickoff 的重复 session。
- Phase 2：Inbox session 标题栏 `conversation.session.header.actions` 加「立项」按钮，点击预填一句触发 agent 开始立项。

### 5.3 新项目 session

- 打开方式：`uiWorkspace.startSession(workspaceId, { prompt: kickoff, whenDraftExists: 'replace' })`。
  - 源码：`ui-workspace/src/client/navigation.ts:337-368`；带 prompt 时只初始化草稿；无 workspace 目标时直接报 `draft.workspaceRequired`，所以必须传 workspaceId。
  - 竞态：`startSession` 从客户端缓存的 `workspaces.list` 解析目标；host 刚注册的 workspace 可能尚未同步。客户端须先等列表出现该 id（订阅 + 超时 5s），超时则落到卡片的「打开项目」按钮。
  - `startSession` 返回 void、不给出 sessionId（`navigation.ts:337`）。首次打开后，客户端从 `workspaces.list` 中该 workspace 的 `sessionIds`（新工作区此时只有这一个）取得 id，回写为 `projectSessionId`；取不到则不记录，后续「打开项目」走第 2 条。
- kickoff 默认（领域无关，可由 agent 改写）：

```
这是一个项目的启动交接。先读 BRIEF.md，然后：
1. 用不超过 5 行复述目标、范围、关键约束
2. 列出第一批任务和验证方式
3. 列出需要我拍板的问题，先不要开始执行
```

### 5.4 旧 session

- 留在 Ungrouped；不迁移、不改标题、不自动归档。
- 会话中的 `created` 卡片即“已创建项目”标记，回查时可一键打开项目。
- `BRIEF.md` 的「来源」写旧 session 标题 + session id。

### 5.5 简单问答的入口

- 同一个「新对话」入口；不需要第二个“快速问”按钮。

---

## 6. Brief 规范（建议，不强制 schema）

写作指南放在插件自带的「立项」skill 中（按需加载，不占每轮 token）；工具描述只保留流程要点。插件不解析 section。建议至少覆盖：

| 核心节 | 说明 |
|---|---|
| 目标 / 要解决的问题 | 为什么做 |
| 已定结论（决定 + 理由） | 最好带被否方案/原因 |
| 范围 / 非目标 | 防止范围膨胀 |
| 约束 / 前提 | 时间、预算、人手、政策、依赖、假设 |
| 未决问题 / 风险 | 不要把不确定伪装成结论 |
| 下一步 / 第一批产出 | 让新 session 能开始 |
| 来源 | 旧 session 标题/id；不复制正文 |

可选节（按项目类型）：成功标准、干系人、时间线/预算、参考资料、术语表、交付物清单、技术栈、合规要求。
原则：一页纸优先；brief 是决策记录，不是完整会议记录。

### 6.1 软校验

`project_propose` 对快照做轻量检查，只产生 warning（显示在卡片上，不阻止创建）：

- 正文少于约 300 字符；
- 未出现“目标/问题”“下一步”类关键词（中英文各一组）；
- 超过 256KB → 硬错误。

### 6.2 AGENTS.md

- 默认写**一行指针**：`项目背景、已定决策与未决问题见 BRIEF.md。`（DSH 自动读取 `AGENTS.md`，不读 `BRIEF.md`）。
- 讨论产生**跨 session 的长期规则**时（回复语言/风格、输出目录/命名、不能动的目录、审批规则、固定命令/工具），agent 可把它们写进 `AGENTS.draft.md`，通过 `agents: "draft"` 传给 propose，卡片里展示，控制在十几行，不复制 brief。
- 用户可在卡片上取消勾选「写入 AGENTS.md」。
- 目标目录已有 `AGENTS.md` 时不写（只在空目录/新目录创建，见 §9.3，实际上不会发生）。

### 6.3 不自动生成的东西

- 不生成 `package.json`、README、测试、git 仓库；由新 session 里的 agent 在 kickoff 后按需决定。

---

## 7. 工具 / API 契约（设计稿，不是最终代码）

### 7.1 Agent 工具：`project_propose`（唯一模型可见工具，无外部副作用）

可见性：只在 Inbox session 中可用。优先用注册时的 `when` 条件（`tools.md:182`）按 session/cwd 过滤；若 `when` 拿不到 session 信息（Phase 0 验证），则保持全局注册但在执行时检查 cwd 不在 `$DSH_HOME/inbox/` 下即返回错误，工具描述写明“仅在 Inbox 对话中使用”。

工具描述要点（模型可见，保持简短）：只有用户明确要求立项时使用；先加载「立项」skill 并写 `BRIEF.draft.md`；调用后告知用户在卡片上确认并结束本轮，不要声称项目已创建。

输入：

```json
{
  "title": "项目名",
  "path": "/abs/path/to/project",
  "kickoff": "....",
  "agents": "pointer"
}
```

- `path` 可选；省略时由 host 按 §9.1 推断。
- `agents`：`"pointer"`（默认）| `"draft"`（读取会议目录的 `AGENTS.draft.md`）| `"none"`。
- draft 路径固定为会议目录下 `BRIEF.draft.md`，不接受参数（杜绝读取任意文件）。

输出（结构化值）：

```json
{
  "proposalId": "p_<26 位 base32 随机>",
  "title": "项目名",
  "path": "/abs/path/to/project",
  "pathSource": "explicit | common-parent | recent-parent | default-root",
  "files": ["BRIEF.md", "AGENTS.md"],
  "warnings": ["brief-short"],
  "next": "已生成预览卡片，请用户点击「创建项目」确认。"
}
```

职责：

1. 确认调用方是 Inbox session：按调用方 sessionId 读取状态目录 `meeting.json`，不存在即拒绝；会议目录取自其中的 `cwd`；
2. 推断/规范化路径并执行 §9.3 全部校验；硬错误直接返回给 agent；
3. 读取 draft（及可选 AGENTS draft），大小检查，软校验；
4. 将内容快照与两部分 sha256 写入状态目录 `proposals/<proposalId>.json`，`revision=1`，state=`proposed`；
5. 将同 session 先前处于 `proposed`/`failed` 的 proposal 标为 `superseded`；
6. 只写插件自己的状态目录；不写会议目录（草稿归 agent），不碰任何项目路径。它有写盘副作用，因此不是“只读”工具；清理策略见 Phase 3。

### 7.2 Host 路由（`ctx.connection.fetch`，仅客户端调用）

#### `POST /api/inbox/session`

请求：`{}`；响应：`{ "sessionId": "...", "cwd": "/home/me/.dsh/inbox/<dirId>" }`

1. 生成随机 id，作为请求 sessionId 与 `dirId`；`mkdir` `$DSH_HOME/inbox/<dirId>/`（`0700`）；
2. `sessionController.create({ cwd, sessionId })`（无 workspaceId；`packages/api/session-controller/src/types.ts:266`、`commands.ts:103`）；
3. 用**返回的** sessionId 写状态目录 `inbox-state/<sessionId>/meeting.json`（`{ sessionId, cwd }`）；
4. 返回 id 与请求不同（G1 预期不会发生：未存储的 id 一定作为新 session 身份）时：**不重命名会议目录**（session header 的 cwd 不可变），照常按返回 id 记录映射并打 warning 日志；所有查找都经由 `meeting.json` 或 session 自身 cwd，目录名只是标签；
5. 第 2 步失败：删除刚建的空会议目录，返回错误；
6. v1 总是新建；“复用空白 Inbox session”放到 Phase 2。

#### 定位与校验（以下 proposal 路由共用）

路径参数 `:sessionId`、`:proposalId`：

1. 格式白名单：`sessionId` 按 DSH session id 的字符集校验（Phase 0 确认格式），`proposalId` 必须匹配 `^p_[a-z2-7]{26}$`；任何含 `/`、`\`、`.` 段的值直接 400；
2. 拼出 `$DSH_HOME/inbox-state/<sessionId>/proposals/<proposalId>.json`，对其 `realpath` 后必须仍位于 `$DSH_HOME/inbox-state/` 下；
3. 文件内的 `sessionId`、`id` 必须与路径参数一致，否则 404；
4. 不做全目录扫描，不维护全局索引。

#### `GET /api/inbox/sessions/:sessionId/proposals/:proposalId`

返回卡片所需全部字段、当前 state、`interrupted`（state=`creating` 但本进程未持有该 proposal 的锁，即上次创建被中断）、`revision`、`draftChanged`（BRIEF/AGENTS 任一草稿 hash ≠ 快照）、`workspaceId?`、`projectSessionId?`。

#### `POST /api/inbox/sessions/:sessionId/proposals/:proposalId/create`

请求体：`{ "writeAgents": true }`（对应卡片勾选）；响应：`{ "workspaceId", "path", "briefPath", "kickoff" }`；错误：409 `superseded` / 409 `draft-changed` / 422 路径校验失败。

#### `POST /api/inbox/sessions/:sessionId/proposals/:proposalId/repropose`

仅当 state=`proposed`/`failed`、无落盘意图、且草稿已修改时可用：**原地更新同一 proposal**——以相同 title/path/kickoff/agents 重读两份草稿，重新执行 §9.3 校验与软校验，替换 snapshot/hash/warnings，`revision+1`，state=`proposed`。响应新的完整 proposal。proposalId 不变，刷新后卡片仍对得上。

#### `POST /api/inbox/sessions/:sessionId/proposals/:proposalId/opened`

请求体：`{ "projectSessionId": "..." }`；仅 state=`created` 时接受，且只写一次（已有值则忽略）。

### 7.3 Create 的步骤与幂等

在 per-proposal 互斥锁内执行（单进程内 Map 锁即可）。

**“本 proposal 的产物”**指：`BRIEF.md`（sha256 = 快照）、`AGENTS.md`（勾选时，sha256 = 快照）、以及本 proposal 的临时文件 `.dsh-inbox-<proposalId>-*.tmp`。

1. `created` → 直接返回已记录结果；`superseded` → 409；`creating`（锁外残留，如崩溃）→ 视为 `failed` 继续；
2. **判定接管（adoption）**：proposal 已有落盘意图 `intent.path`（说明此前某次 create 已越过第 4 步），且目标目录：存在、不是符号链接、`realpath` = `intent.path`、其中每个条目都属于“本 proposal 的产物”（**可以为空**）→ `adopting = true`。否则 `adopting = false`；
3. 非接管时比对草稿：BRIEF/AGENTS 任一草稿 hash ≠ 快照 → 409 `draft-changed`，状态不变；
4. 路径校验（§9.3）；接管时放宽两条：允许目录非空（仅限第 2 步确认的产物）；允许 `resolveByPath(path)` 已返回 workspace——此时采用该 workspace 的 id；然后 state=`creating`，写入意图 `{ path: <规范路径> }`，落盘（**必须在任何项目路径写操作之前**）；
5. 接管时删除本 proposal 的临时文件；
6. 父目录 `mkdir -p`；**最后一级非 recursive `mkdir`**：EEXIST 时，若接管、或目录为空（§9.3 本就允许空目录）→ 继续，否则失败；
7. 写 `BRIEF.md`（目标已存在且 hash = 快照 → 跳过；存在但不一致 → 失败）：
   1. 在目标目录以 `wx` 创建临时文件 `.dsh-inbox-<proposalId>-BRIEF.md.tmp`，写全内容，`fsync`；
   2. `fs.link(tmp, BRIEF.md)`——目标存在则 EEXIST，不会覆盖；**不用 rename**（会覆盖）；
   3. `unlink(tmp)`，对目录 `fsync`；
   这样 `BRIEF.md` 要么不存在、要么是完整内容；崩溃只会留下本 proposal 的临时文件，下次接管时清理；
8. 同法写 `AGENTS.md`（若勾选）；
9. 写完后对目标目录 `realpath`，必须等于意图里的规范路径（防并发替换为符号链接，见 §9.3）；
10. `workspaceRegistry.create(path, title)`：对同一规范路径本身幂等，已存在时返回原记录（`docs/subsystems/workspace.md:120`）。接管且第 4 步已拿到 id 时跳过；
11. state=`created`，记录 `workspaceId`、时间，保留意图（供审计）；落盘；
12. 任一步失败：state=`failed` + 错误码/信息（意图保留，供下次接管）；不删除任何已写的项目文件。

接管只认“意图已落盘 + 目录内容 ⊆ 本 proposal 产物”，不比较 workspace 标题（用户可能已在 DSH 里改名）。各崩溃点的恢复：

| 崩溃点 | 残留 | 重试结果 |
|---|---|---|
| 第 4 步写意图前 | 无 | 正常创建 |
| 第 6 步 mkdir 后 | 空目录 | 接管，继续写文件 |
| 第 7 步写临时文件中 | 空目录 + 残缺 tmp | 接管，删除 tmp 重写 |
| 第 7 步 link 后、unlink 前 | `BRIEF.md` + tmp | 接管，删除 tmp，跳过 BRIEF |
| 第 10 步注册后、第 11 步前 | 完整文件 + 已注册 | 接管，采用已有 workspace id |

### 7.4 客户端行为

- 入口按钮 → `POST /api/inbox/session` → `uiWorkspace.openSession(sessionId)`。
- Proposal 卡片：挂载时 GET；点击创建 → POST create → 等 `workspaces.list` 出现 workspaceId（≤5s）→ `startSession(workspaceId, { prompt: kickoff })` → 取首个 sessionId → POST opened；任何一步失败都把状态反映在卡片上。
- 409 `draft-changed` → 卡片切到「草稿已修改」态；点「按当前草稿重新预览」→ POST repropose → 原位显示新 revision（同一 proposalId）。
- 不轮询；无后台定时器。

---

## 8. 技术架构

### 8.1 Host 半

- 注入：`connection`、`tools`、`workspaceRegistry`、session controller（或等价服务）、skills 注册（若需要以插件形式提供 skill）。
- 工具：`project_propose`。
- 路由：`POST /api/inbox/session`；`/api/inbox/sessions/:sessionId/proposals/:proposalId` 下的 `GET`、`POST create`、`POST repropose`、`POST opened`。
- 状态：会议目录只有 agent 写的草稿；插件状态全部在 `$DSH_HOME/inbox-state/<sessionId>/`（`meeting.json`、`proposals/<proposalId>.json`，含快照、hash 与意图），不在任何 session 的 cwd 内。状态文件用“写临时文件 + rename”原子更新（这里覆盖自己的状态文件是预期行为）。无内存态需持久化。
- 日志：记录 path/title/sessionId/proposalId/state 变化，不记录 brief 全文。
- 零第三方依赖；只用 Node 内置模块。

### 8.2 Client 半

- 注入：`slots`、`uiWorkspace`、`workspaces`、`conversation`（预填输入框）、`locale`。卡片与入口组件经 registration `inject` 工厂从 `apply` 闭包拿到所需回调。
- 入口：`sidebar.footer.action` + 可关闭的 DOM 注入增强（见 §5.1）。
- 卡片：`tool.call.toolview` key=`project_propose`。
- 无构建：浏览器半为手写 `__ModuleLoader__` 工厂，React 来自平台模块表。
- 主题：只用 DSH 主题 token；样式通过 `ctx.effect` 注入 `<style data-dsh-plugin="dsh-inbox">`。

### 8.3 包结构（建议）

```
dsh-inbox/              # 独立公开仓库根目录（见 §15）
  package.json          # dsh.bundle + dsh.client；不设 private: true
  LICENSE               # MIT
  CHANGELOG.md
  .github/workflows/test.yml
  cordis.patch.yml
  lib/index.js          # Host 半：路由、工具注册
  lib/proposal.js       # 路径推断/校验、快照、状态机、create
  lib/client.js         # Client 半：入口、卡片
  skills/立项/SKILL.md   # brief 指南 + 流程
  locale/zh.json, en.json
  icon.svg
  tests/host.test.mjs
  tests/proposal.test.mjs
  tests/client.test.mjs
  README.md
```

`engines.dsh` 初始范围建议 `>=0.2.1-rc.5 <0.3.0`，在 0.2.2-rc.1 上实测后放宽。

---

## 9. 路径 / 命名规则

### 9.1 默认路径推断（host 实现）

优先级：

1. 调用方给了 `path` → 用（`pathSource: explicit`）；
2. 已有 workspace 有明显共同父目录（≥2 个在同一父目录下，取数量最多者）→ `<父目录>/<slug>`；
3. 否则最近使用 workspace 的父目录；
4. 没有任何 workspace → 配置项默认根（默认 `~/projects`）。

slug 由 agent 在 `title` 之外不单独提供时，host 从 title 生成 ASCII kebab-case；无法生成（如纯中文）时返回错误要求 agent 显式给 `path`。卡片始终显示绝对路径与 `pathSource`。

### 9.2 名字

- 项目标题 = 人类可读，可中文；workspace 标题允许重复（DSH 允许），同名给 warning；
- 目录名由 agent/用户决定，插件只做合法性校验。

### 9.3 校验（propose 与 create 各执行一次）

- 必须绝对路径；拒绝相对路径、含 `..` 段；
- 符号链接与竞态：
  - 对**最近一个已存在的祖先**做 `realpath`，得到规范父路径；
  - 最终目标若已存在：先 `lstat`，是符号链接则拒绝；再 `realpath` 并以结果做下列判断；
  - create 阶段重新执行全部校验（不信任 propose 时的结论）；
  - 创建与写入使用不跟随最终符号链接的操作：非 recursive `mkdir`（目标存在即 EEXIST，不跟随）、临时文件以 `wx`（`O_CREAT|O_EXCL`，目标为符号链接时同样 EEXIST）创建，再 `link` 到最终文件名（目标存在即 EEXIST）；
  - 写完后再 `realpath` 目标目录，与预期规范路径不一致即失败（覆盖父目录在校验后被替换为符号链接的情形）；
  - 威胁模型：单用户本机，防误操作与模型生成的异常路径；不追求对抗同机恶意进程的完全竞态安全。
- 拒绝：`$DSH_HOME` 内部任意位置、文件系统根、`$HOME` 本身、系统目录（`/etc`、`/usr` 等前缀）；
- 目标不存在 → 允许；存在且为空目录 → 允许；存在且非空 → 拒绝（接管情形除外，见 §7.3）；存在但不是目录 → 拒绝；
- 已被注册为 workspace（`workspaceRegistry.resolveByPath`）→ 拒绝（接管情形除外，见 §7.3）；
- 位于某个已注册 workspace 内部 → warning（嵌套项目）；
- 失败信息明确，不静默。

---

## 10. 安全 / 权限

- **威胁模型**：agent 可能受网页/文件内容 prompt injection 影响（web search 默认开），因此 agent 可写的任何东西都不能作为“用户确认过的内容”的依据。
- **模型没有任何能在 sandbox 外产生副作用的工具。** `project_propose` 只写插件状态目录。
- proposal 状态、快照与 hash 存放在 `$DSH_HOME/inbox-state/`，不在 Inbox session 的 cwd 内；`workspace-write` 沙箱只允许写 cwd（`docs/subsystems/sandbox.md`），agent 无法改写它们。agent 能改的只有草稿，而草稿变化会被 hash 发现并要求重新预览。
- **边界**：在 `danger-full-access` 预设下 agent 本就能写任意位置（包括状态目录），也能直接用 shell 建目录；此时插件无法保证“只有用户确认才创建”，README 需明确说明。
- 目录创建/工作区注册只经由 create 路由，只能由用户在卡片上点击触发；与会话审批策略（`ask`/`never`/`auto`）无关。
- 写入内容 = propose 时的快照，与卡片预览一致；草稿在预览后被修改则拒绝创建、要求重新预览，不会写入用户没看过的内容，也不会静默写入旧版本。
- 路由参数严格白名单 + realpath 包含校验，防路径穿越（§7.2）。
- 不覆盖既有文件（`wx`/`link`）；不删除任何东西。
- draft 路径固定在会议目录，工具不接受文件路径参数。
- 残余风险：路由本身无法区分“用户点击”与“页面内其它脚本调用”；依赖 DSH 网关的同源/鉴权（与其它插件路由一致）。前端不引入第三方脚本。

---

## 11. 测试计划

### Host 单测

- 路径推断：显式、共同父目录、最近 workspace、默认根、无 workspace、中文 title 无法生成 slug；
- 路径校验：相对路径、`..`、祖先为符号链接指向 `$DSH_HOME`/系统目录、最终目标为符号链接、校验后目标被替换为符号链接（写后 realpath 复核失败）、已存在非空、非目录、已注册 workspace、嵌套 warning；
- 快照：propose 后修改 `BRIEF.draft.md` 或 `AGENTS.draft.md`（`agents: "draft"`）→ GET 显示 `draftChanged`、create 返回 409；repropose 原地更新同一 id、revision+1；未修改时写入内容 = 快照；
- repropose → 模拟刷新（重新 GET 原 proposalId）→ 显示新 revision 并可创建；
- 状态隔离：proposal/快照文件不在 session cwd 内；在 cwd 内伪造 proposal 文件不影响路由结果；
- 状态机：supersede、重复 create 返回同结果、superseded 返回 409、`creating` 残留恢复；
- 幂等重试：按 §7.3 崩溃点表逐一注入（mkdir 后空目录、tmp 写一半、link 后 unlink 前、注册后写状态前），再次 create 都能接管并完成、不覆盖、不产生第二个 workspace、不留临时文件；
- 接管边界：无落盘意图、目录内多出无关文件、`BRIEF.md` hash 不同、目录为符号链接、realpath ≠ 意图路径 → 不接管、失败；
- 路由定位：非法 sessionId/proposalId（含 `..`、`/`、编码后的分隔符）→ 400；文件内 id 与路径不符 → 404；跨 session 访问 → 404；
- 不覆盖：目标 `BRIEF.md` 在校验后被外部写入 → EEXIST 且 hash 不同 → failed；
- Inbox session：会议目录与状态目录 0700、无 workspace、`meeting.json` 写入；create 返回不同 sessionId 时不重命名目录、按返回 id 记录映射且后续 propose/路由正常；create 失败时清理空会议目录；
- 非 Inbox session 调用 `project_propose` 被拒。

### Client 单测（假 React/ctx）

- footer 入口；DOM 注入找到/找不到锚点、语言切换、窄轨道；设置关闭后不注入；
- 卡片各状态渲染；GET 失败退回文本；
- 创建 → 等待 workspace 列表 → `startSession({prompt})` → 回写 projectSessionId；列表超时 → 显示「打开项目」；
- 「打开项目」三种分支：有 projectSessionId → `openSession`；无/已归档 → `startSession` 不带 prompt；workspace 已删 → 提示；
- 「草稿已修改」态与重新预览；「修改」预填与无法预填时的退化；
- 错误态/toast。

### 集成 / 手工验收

1. 点击「新对话」→ 无 workspace 的空白 session；工具可用；web search 可用；
2. 简单问答后离开 → Ungrouped 可搜索；
3. 讨论 → agent 写 draft → propose → 卡片预览 → 修改 → 新卡片、旧卡片 superseded；
4. 点击创建 → 目录/workspace/`BRIEF.md`/`AGENTS.md` 创建；
5. 新 session 自动打开，kickoff 预填但未发送；手动发送 → 新 session 读到 BRIEF.md；
6. 在项目里再开第二个 session → 通过 AGENTS.md 指针知道 BRIEF.md；
7. 旧 session 回放：卡片显示「已创建 · 打开项目」，刷新后点击回到首次创建的项目会话，不产生新的 kickoff session；
8. 预览后手动改 `BRIEF.draft.md` 再点创建 → 被拒并提示重新预览；
9. 在 `danger-full-access` 与 `workspace-write` 预设下全流程都可用；
10. 路径冲突/失败/重试；
11. 窄侧栏、刷新、重载、DSH 重启（重启后卡片状态正确，`proposed` 卡片仍可创建）。

---

## 12. 分期

### Phase 0：验证门槛（不写正式功能；每项必须得出结论才能进入 Phase 1）

| # | 验证项 | 通过标准 | 不通过时的退路 |
|---|---|---|---|
| G1 | host 侧 session controller 的服务名与注入方式；`create({ cwd, sessionId })` | 插件能注入并调用；传入新随机 sessionId 时一定新建（源码注释：未存储的 id 作为新 session 身份）；返回 id 与传入一致；session 不进入任何 workspace | 不指定 sessionId，按返回 id 写 `meeting.json` 映射（不重命名目录）；仍不行则退回插件内临时 workspace |
| G2 | 无 workspace session 的 composer/工具/附件/web search | 与普通 session 一致 | 同上，临时 workspace |
| G3 | `uiWorkspace.openSession(id)` 在客户端 session 列表尚未同步时 | 能打开；或能确定“等列表出现该 id 再打开”的可靠条件 | 等待列表 + 超时 toast |
| G4 | `startSession(wsId, { prompt })` | 只预填、不自动发送；新工作区里打开的 session 能从 `workspaces.list` 取到 id | 不自动发送不成立 → 打开空白 + 复制 kickoff；取不到 id → 不记录 projectSessionId |
| G5 | `tool.call.toolview` 自定义卡片 | 实时、回放旧 session、host 重启后都能渲染；能拿到 sessionId；能调用插件路由与闭包里的 `uiWorkspace` | 退回 tool result 文本 + footer/标题栏按钮执行创建（仍是人点击） |
| G6 | 卡片内预填输入框 | 能拿到当前 session 的 `SessionInput` 并 `setDraft` | 复制到剪贴板 + toast |
| G7 | 工具 `when` 条件 | 能按 session/cwd 过滤 | 执行时拒绝 |
| G8 | Inbox session 在 `workspace-write`、`danger-full-access` 下的读写范围 | 能读 cwd 外文件、能写 cwd | 在 README 中说明限制 |
| G9 | 插件提供 skill 的方式 | 随包发布即可被加载 | 工具描述中内联精简版指南 |
| G10 | 从 GitHub 安装：`git+https://github.com/<owner>/dsh-inbox.git#<commit>`（`packages/boot/plugin-market/README.md:100`） | 插件管理器安装并加载 host、client 两半 | 发布到 npm |
| G11 | DOM 注入锚点 | 中英文、宽/窄栏、macOS 收起态下都能定位或安全放弃 | 只保留 footer 入口 |

### Phase 1：MVP

- 「新对话」入口（footer + DOM 增强）+ Inbox session；
- `project_propose` + 快照 + 落盘 proposal + 状态机；
- Proposal 卡片 + create 路由 + 打开新 session；
- 「立项」skill；AGENTS 指针；
- 基础测试；
- 公开仓库初始化：LICENSE、中英 README、CI、第一个 tag，并在第二台机器上按 README 从 git 安装验证（§15）。

### Phase 2：打磨

- 标题栏「立项」按钮；
- 复用空白 Inbox session；
- AGENTS 长期规则草稿（`agents: "draft"`）与卡片勾选；
- 错误文案、兼容性矩阵。

### Phase 3：可选

- Inbox 筛选/标签/自动归档；会议目录清理策略；
- 讨论期间产生的其它文件的处理策略（例如在卡片里勾选一起复制）；
- 多项目模板（非固定 schema）。

---

## 13. 风险与待验证

| 风险 | 影响 | 计划 |
|---|---|---|
| 新会话按钮旁无官方 slot | DOM 注入脆弱 | footer 保底必做；DOM 注入可关闭、找不到锚点静默退化（G11） |
| `create({cwd})` 无 workspace 的 composer/工具行为 | Inbox 可能不可用 | Phase 0 实测；失败则退回插件内临时 workspace |
| 自定义卡片回放/重启后行为 | 旧 session 无法再创建/打开 | 卡片只依赖 sessionId + proposalId + GET；GET 失败退回文本摘要（G5） |
| 创建中途崩溃 | 重试卡死或重复注册 | 意图先于写盘落盘 + 接管规则 + 崩溃点表与故障注入测试（§7.3） |
| 崩溃后卡片停在 `creating` | 无重试入口 | GET 返回 `interrupted`，卡片显示「继续创建」 |
| `danger-full-access` 下 agent 可绕过确认 | 确认机制失效 | 文档说明；不在插件内假装能防 |
| workspace 列表同步延迟 | 自动打开失败 | 等待 + 超时；卡片「打开项目」兜底 |
| `startSession({prompt})` 自动发送 | 违背“预填、手动发送” | Phase 0 实测（源码显示只初始化草稿）；若不符改为打开空白 + 复制 kickoff |
| `when` 无法按 session 过滤 | 项目 session 里也能看到 propose 工具 | 执行时拒绝 + 工具描述限定 |
| 中文项目名 → 目录名 | 路径不合预期 | host 生成 slug 失败即要求显式 path；卡片显示绝对路径 |
| DSH 0.2.x 快速迭代 | API/UI 变化 | 单插件、少量注入点、兼容性测试、降级 |
| 旧 Inbox 增多 | Ungrouped 变吵 | v1 接受；Phase 3 加筛选/归档 |

---

## 14. 已决与待 review

已决定（见 §0.2）：确认机制、威胁模型与状态隔离、host→client 通道、proposal 持久化/幂等/接管、repropose 原地更新、路由定位、草稿变更处理、「打开项目」语义、入口方案（放弃 panellist）、AGENTS 指针、路径推断位置。

仍请 review：

1. 软校验关键词与阈值；
2. 会议目录的长期清理策略（多久、是否随 session 归档）；
3. 路由鉴权残余风险是否需要额外措施（如一次性 nonce 仅随卡片下发）。

---

## 14.1 v0.1 实现说明（与上文的差异）

实现即本仓库。与设计正文不同或补充的地方：

| 项 | 实现 | 原因 |
|---|---|---|
| 路由形式 | 固定路径 `/api/dsh-inbox/session`、`/api/dsh-inbox/proposal`（GET，query 传 `sessionId`/`proposalId`）、`/api/dsh-inbox/proposal/{create,repropose,opened}`（POST，JSON body 传 id） | 只确认了 `connection.fetch.register` 的精确路径用法；id 白名单与 realpath 包含校验不变 |
| 「新会话」旁 DOM 注入 | **v0.1 不实现**，只有 footer 入口 | 往 React 管理的节点里插外部 DOM 有协调风险；等 G11 验证后再做 |
| 工具可见性 | 不用 `when`；执行时按 `inbox-state/<sessionId>/meeting.json` 是否存在判断，非 Inbox 会话返回 `not-inbox-session` | `when` 能否拿到 session 未验证（G7） |
| skill | 名为 `inbox-project-kickoff`，通过 `ctx.plugin({ inject: ['skills'] })` 子插件注册，skills 服务不存在时自动跳过 | 不让 skills 成为硬依赖（G9） |
| sessionId 格式 | 路由只接受 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`；DSH 实际为 UUID | 单段安全路径即可 |
| 首个项目会话 id | `startSession` 后从 `workspaces.list` 取新工作区的 session id 回写 `opened` | `startSession` 不返回 id |
| **Inbox 会话的空白期**（G2 实测不通过） | 新对话先挂在以自己会议目录注册的**临时工作区**（标题「新对话」）上；host 监听 `session/event` 的第一个 `turn/start` 时删除该临时注册（目录与会话日志保留），会话落到 Ungrouped；仍空白的 Inbox 会话被下次点击复用；启动时扫描补做落地 | DSH 把“空白（无 `turn/start`）且无工作区”的会话当作“工作区已删除”，禁用输入框（`ui-conversation/src/client/skeleton/ConversationContent.tsx`：`inert = hero && chipTitle === undefined`）；空白判定只看 `turn/start`（`session-controller/src/list.ts:51`），不开始一轮无法绕开；删除工作区注册不会关闭当前会话（只有归档会） |
| 「修改」预填 | `sessions.binding(id).ctx.get('conversation').input.for(ctx).setDraft()`；失败退化为剪贴板 | 同 §5.2 |

测试：`npm test` 共 31 个（路径校验、状态机、6 个崩溃点接管、路由 id 校验、客户端辅助函数）。Phase 0 门槛 G1–G11 仍需在真实 DSH 上验证。

## 15. 开源与多机分发

### 15.1 仓库

- **独立公开仓库** `dsh-inbox`，只放本插件代码、测试、中英 README、LICENSE（MIT）、CHANGELOG。
- 不提交 `node_modules`、本机配置、日志、会话/proposal 数据。

### 15.2 代码与配置的可移植性

- 不硬编码任何个人路径、用户名、邮箱、机器名；所有位置从 DSH 提供的值推导（`$DSH_HOME`、`os.homedir()`）。
- 可配置项（通过 DSH 插件配置，均有通用默认值）：
  - `defaultProjectRoot`：默认 `~/projects`（§9.1 第 4 级）；
  - `entryNextToNewSession`：是否启用 DOM 注入入口，默认开；
  - `writeAgentsPointer`：默认开。
- 路径处理同时考虑 macOS / Linux（Windows 不承诺，但不写 POSIX 专有假设：用 `path` 模块、不拼 `/`）。
- 文案全部走 `locale/zh.json` + `locale/en.json`；README 以英文为主、附中文版。
- 日志不含 brief 正文；issue 模板提示用户贴日志前检查路径。

### 15.3 安装与升级

- 安装：DSH 插件管理器支持 `git+<url>.git#<commit>`（及 `&path:/<子目录>`）形式（`packages/boot/plugin-market/README.md:100`）；README 给出固定 tag/commit 的安装命令。
- 发版：语义化版本 + git tag；`engines.dsh` 写明已验证范围；破坏性变更写进 CHANGELOG。
- 后续可选：发布到 npm 或提交到 DSH 插件市场索引，便于一键安装与升级提示；v1 先只做 git 安装。

### 15.4 多机语义

- 每台机器的 Inbox session、会议目录、proposal 都是**本机数据**，不跨机同步；插件不做同步。
- 卡片在别的机器上不可能出现（session 本身不同步），无需处理跨机 proposal。
- 项目目录若放在同步盘/git 仓库里，由用户自己管理；插件只负责首次创建。

### 15.5 CI

- GitHub Actions：Node 22，运行 host / proposal / client 单测（假 ctx，不依赖 DSH 安装）；
- 额外检查：`package.json` 的 `files` 白名单、两份 locale 键一致、仓库内无绝对 home 路径（简单 grep）。

---

## 16. 证据索引

- 无 workspace session 创建：`packages/api/session-controller/src/types.ts:266`（`cwd` 与 `workspaceId` 互斥、可指定 `sessionId`）；`commands.ts:103`（create → attach）
- 工作区注册幂等、归属规则：`docs/subsystems/workspace.md:78,120`
- 工具审批与 pre-execute 决策：`docs/subsystems/approval.md`；`docs/subsystems/tools.md:530-561`
- 权限预设（`danger-full-access` = 审批 `never`；`auto` 由审阅模型放行）：`docs/subsystems/permission-presets.md`
- 工具注册 `when` 条件：`docs/subsystems/tools.md:182`
- 按工具名注册卡片：`packages/client/ui-tool/README.md:36-48`（`tool.call.toolview`）
- `startSession` 草稿预填与 workspace 要求：`packages/client/ui-workspace/src/client/navigation.ts:337-368`
- 新会话按钮实现（无 slot）：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:342-372`
- sidebar slot 声明与 cardinality：`packages/client/ui-sidebar/src/client/index.ts:84-93`；`sidebar.workspaces` 占用方：`packages/client/ui-workspace/src/client/index.ts:330`
- DSH 工作目录语义：`docs/subsystems/working-directory.md`
