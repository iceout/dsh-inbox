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

import crypto from 'node:crypto'

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

/**
 * Create one Inbox session. The meeting directory is never renamed: a session's
 * header cwd is immutable, so the mapping lives in `inbox-state/<sessionId>/meeting.json`.
 */
export function createSessionFactory({ store, sessionController, log }) {
  return async () => {
    const dirId = crypto.randomUUID()
    const cwd = await store.createMeetingDir(dirId)
    let sessionId
    try {
      const created = await sessionController.create({ cwd, sessionId: dirId })
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : undefined
      if (sessionId === undefined) throw new Error('session controller returned no sessionId')
    } catch (error) {
      await store.removeEmptyDir(cwd)
      throw error
    }
    if (sessionId !== dirId) log(`session id ${sessionId} differs from requested ${dirId}; keeping directory, recording mapping`)
    await store.saveMeeting(sessionId, cwd)
    return { sessionId, cwd }
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

  const handlers = createHandlers({
    service,
    createSession: createSessionFactory({ store, sessionController: ctx.sessionController, log }),
    log,
  })
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
