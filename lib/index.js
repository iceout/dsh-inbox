/**
 * dsh-inbox — host half.
 *
 * - `POST /api/dsh-inbox/session` creates a workspace-less Inbox session whose
 *   cwd is a fresh meeting directory under `$DSH_HOME/inbox/`.
 * - `project_propose` (the only model-visible tool) validates a target path and
 *   snapshots the agent's drafts into plugin state under `$DSH_HOME/inbox-state/`.
 * - The proposal card's buttons call the remaining routes; only a user click
 *   creates directories or registers workspaces.
 *
 * Node built-ins only. `apply()` never throws on setup problems; it warns.
 */

import { createInboxSessions, DEFAULT_INBOX_TITLE } from './inbox-session.js'
import { InboxService } from './proposal.js'
import { createHandlers, installRoutes } from './routes.js'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN } from './skill.js'
import { StateStore } from './store.js'
import { createProposeTool } from './tool.js'
import { dshHome } from './paths.js'

export const name = 'dsh-inbox'
export const inject = ['connection', 'tools', 'workspaceRegistry', 'sessionController']

/** Defensive config parsing: wrong types fall back to defaults. */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    defaultProjectRoot: typeof config.defaultProjectRoot === 'string' && config.defaultProjectRoot.trim() !== ''
      ? config.defaultProjectRoot.trim()
      : '~/projects',
    writeAgentsPointer: config.writeAgentsPointer !== false,
    inboxTitle: typeof config.inboxTitle === 'string' && config.inboxTitle.trim() !== ''
      ? config.inboxTitle.trim()
      : DEFAULT_INBOX_TITLE,
  }
}

function logger(ctx) {
  return message => {
    try {
      if (typeof ctx?.logger?.info === 'function') ctx.logger.info(`[dsh-inbox] ${message}`)
      else console.info(`[dsh-inbox] ${message}`)
    } catch {
      // logging must never break the plugin
    }
  }
}

export function apply(ctx, rawConfig) {
  const log = logger(ctx)
  const config = resolveConfig(rawConfig)
  const home = dshHome()
  const store = new StateStore({ dshHome: home })
  const service = new InboxService({
    store,
    registry: ctx.workspaceRegistry,
    dshHome: home,
    defaultProjectRoot: config.defaultProjectRoot,
    writeAgentsPointer: config.writeAgentsPointer,
    log,
  })

  ctx.effect(() => ctx.tools.register(createProposeTool(service)), 'dsh-inbox: project_propose tool')

  const sessions = createInboxSessions({
    store,
    sessionController: ctx.sessionController,
    registry: ctx.workspaceRegistry,
    title: config.inboxTitle,
    log,
  })
  // First turn of a pending Inbox session: drop its temporary workspace so it lands in Ungrouped.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start' || typeof session?.id !== 'string') return
    sessions.onTurnStart(session.id)?.catch(error => log(`settle failed: ${error instanceof Error ? error.message : String(error)}`))
  })
  sessions.sweep().catch(error => log(`startup sweep failed: ${error instanceof Error ? error.message : String(error)}`))

  const handlers = createHandlers({ service, createSession: () => sessions.create(), log })
  ctx.effect(() => installRoutes(ctx.connection, handlers), 'dsh-inbox: routes')

  // The skill is optional: only registered where the skills service exists.
  try {
    ctx.plugin({
      name: 'dsh-inbox-skill',
      inject: ['skills'],
      apply(skillCtx) {
        skillCtx.effect(() => skillCtx.skills.register({
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN,
          content: SKILL_CONTENT,
          source: 'runtime',
        }), 'dsh-inbox: kickoff skill')
      },
    })
  } catch (error) {
    log(`skill registration unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
