/** The "project kickoff" skill: brief-writing guide and the propose workflow. Loaded on demand. */

export const SKILL_NAME = 'inbox-project-kickoff'

export const SKILL_DESCRIPTION = 'Turn the current Inbox conversation into a new project: write BRIEF.draft.md, then call project_propose so the user can review and create it.'

export const SKILL_WHEN = 'Use only in an Inbox conversation when the user explicitly asks to start/create a project (立项 / 创建项目 / turn this discussion into a project).'

export const SKILL_CONTENT = `# 立项 / Project kickoff

只在用户明确要求立项时使用。Use only when the user explicitly asks to create a project.

## 流程 / Workflow

1. 在当前工作目录写 \`BRIEF.draft.md\`（这是会议目录；不要写到别处）。
2. 只有讨论中出现**跨 session 的长期规则**（回复语言/风格、输出目录/命名、不能动的目录、审批规则、固定命令）时，才另写 \`AGENTS.draft.md\`（十几行以内，不要复制 brief），并在调用时传 \`agents: "draft"\`。否则不传，插件会写一行指向 BRIEF.md 的 AGENTS.md。
3. 调用 \`project_propose\`：
   - \`title\`：人类可读项目名，可中文；
   - \`path\`：用户给过路径就用绝对路径；否则省略，由插件推断（中文标题无法生成目录名时需要你给出 ASCII 路径）；
   - \`kickoff\`：可选；新项目第一条消息，会预填到输入框，不会自动发送。
4. 告诉用户在对话中的预览卡片上检查并点击「创建项目」，然后结束本轮。**不要声称项目已创建**；你无法替用户创建。
5. 用户要求修改时，更新草稿后再次调用 \`project_propose\`（旧卡片会自动作废）。

## BRIEF 建议覆盖 / Brief checklist

不强制模板；按项目类型组织 Markdown，一页纸优先。brief 是决策记录，不是会议纪要。

| 节 | 说明 |
|---|---|
| 目标 / 要解决的问题 | 为什么做 |
| 已定结论（决定 + 理由） | 最好带被否方案及原因 |
| 范围 / 非目标 | 防止范围膨胀 |
| 约束 / 前提 | 时间、预算、人手、政策、依赖、假设 |
| 未决问题 / 风险 | 不要把不确定伪装成结论 |
| 下一步 / 第一批产出 | 让新 session 能直接开始 |
| 来源 | 本次 Inbox 对话的标题与 session id；不复制对话正文 |

可选：成功标准、干系人、时间线/预算、参考资料、术语表、交付物、技术栈、合规要求。

不要生成 package.json、README、测试或 git 仓库；这些由新项目会话按需决定。
`
