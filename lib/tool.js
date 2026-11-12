/** The single model-visible tool: `project_propose`. No side effects outside plugin state. */

import { SKILL_NAME } from './skill.js'

export const TOOL_NAME = 'project_propose'

const DESCRIPTION = [
  'Only in Inbox conversations, and only when the user explicitly asks to create a project (立项/创建项目).',
  `First load the "${SKILL_NAME}" skill and write BRIEF.draft.md in the current directory.`,
  'This tool validates the target path and snapshots the drafts; it does NOT create anything.',
  'The user confirms by clicking "Create project" on the preview card. After calling, tell the user to review the card and end your turn; never claim the project was created.',
].join(' ')

/**
 * @param {import('./proposal.js').InboxService} service
 */
export function createProposeTool(service) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable project title (any language).' },
        path: { type: 'string', description: 'Absolute project directory. Omit to let the plugin infer one from existing workspaces.' },
        kickoff: { type: 'string', description: 'Optional first message for the new project session; prefilled, never auto-sent.' },
        agents: { type: 'string', enum: ['pointer', 'draft', 'none'], description: '"pointer" (default): one-line AGENTS.md pointing to BRIEF.md; "draft": use AGENTS.draft.md for long-lived rules; "none": no AGENTS.md.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          pathSource: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          next: { type: 'string' },
        },
        required: ['proposalId', 'sessionId', 'title', 'path', 'pathSource', 'files', 'warnings', 'next'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Proposal ${value.proposalId} ready (not created yet).`,
          `Title: ${value.title}`,
          `Path: ${value.path} (${value.pathSource})`,
          `Files: ${value.files.join(', ')}`,
          value.warnings.length > 0 ? `Warnings: ${value.warnings.join(', ')}` : 'Warnings: none',
          value.next,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ dshInbox: { sessionId: value.sessionId, proposalId: value.proposalId } }),
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('project_propose must be called from a conversation.')
      }
      return service.propose(sessionId, args ?? {})
    },
  }
}
