/**
 * Inbox session lifecycle.
 *
 * DSH disables the composer of a *blank* session (no `turn/start` yet) that
 * belongs to no workspace — it reads that state as "the workspace was deleted"
 * (ui-conversation ConversationContent: `inert = hero && chipTitle === undefined`).
 * So an Inbox session starts attached to a temporary workspace registered on
 * its own meeting directory, and is "settled" on its first `turn/start`: the
 * temporary registration is deleted (directory and session log are kept) and
 * the session drops to Ungrouped with its cwd unchanged.
 *
 * While still blank, a pending Inbox session is reused by the next "New chat"
 * click instead of creating another temporary workspace.
 */

import crypto from 'node:crypto'

export const DEFAULT_INBOX_TITLE = '新对话'

/**
 * @param {object} deps
 * @param {import('./store.js').StateStore} deps.store
 * @param {any} deps.sessionController host `sessionController`
 * @param {any} deps.registry host `workspaceRegistry`
 * @param {string} [deps.title] temporary workspace title shown while blank
 * @param {(message: string) => void} [deps.log]
 */
export function createInboxSessions({ store, sessionController, registry, title = DEFAULT_INBOX_TITLE, log = () => {} }) {
  /** sessionIds currently pending settlement (in-memory index of meeting.json state). */
  const pending = new Set()
  let chain = Promise.resolve()
  /** Serialize create/settle so a click and a turn/start cannot interleave. */
  const serial = fn => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  async function summaries() {
    try {
      const controller = new AbortController()
      const value = await sessionController.list({}, controller.signal)
      const map = new Map()
      for (const item of value?.items ?? []) {
        if (typeof item?.sessionId === 'string') map.set(item.sessionId, item)
        else if (typeof item?.id === 'string') map.set(item.id, item)
      }
      return map
    } catch (error) {
      log(`session list unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  async function settleNow(sessionId) {
    const meeting = await store.loadMeeting(sessionId)
    if (meeting === undefined || meeting.settled === true) {
      pending.delete(sessionId)
      return false
    }
    if (typeof meeting.tempWorkspaceId === 'string') {
      try {
        await registry.delete(meeting.tempWorkspaceId)
      } catch (error) {
        log(`could not remove temporary workspace ${meeting.tempWorkspaceId}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }
    const { tempWorkspaceId: _drop, ...rest } = meeting
    await store.writeMeeting({ ...rest, settled: true, settledAt: new Date().toISOString() })
    pending.delete(sessionId)
    log(`settled inbox session ${sessionId}`)
    return true
  }

  /** Called for every `turn/start`; cheap when the session is not ours. */
  function onTurnStart(sessionId) {
    if (!pending.has(sessionId)) return undefined
    return serial(() => settleNow(sessionId))
  }

  /** Newest pending meeting whose session is still blank and whose temp workspace still exists. */
  async function reusable() {
    const meetings = (await store.listMeetings()).filter(m => m.settled !== true && typeof m.tempWorkspaceId === 'string')
    if (meetings.length === 0) return undefined
    const known = await summaries()
    if (known === undefined) return undefined
    meetings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    for (const meeting of meetings) {
      const summary = known.get(meeting.sessionId)
      if (summary === undefined) continue
      if (summary.blank === false) {
        await settleNow(meeting.sessionId)
        continue
      }
      if (summary.blank === true && registry.get?.(meeting.tempWorkspaceId) !== undefined) return meeting
    }
    return undefined
  }

  async function createNow() {
    const reuse = await reusable()
    if (reuse !== undefined) {
      pending.add(reuse.sessionId)
      return { sessionId: reuse.sessionId, cwd: reuse.cwd, reused: true }
    }
    const dirId = crypto.randomUUID()
    const dir = await store.createMeetingDir(dirId)
    let workspace
    let sessionId
    try {
      workspace = await registry.create(dir, title)
      if (typeof workspace?.id !== 'string') throw new Error('workspace registry returned no id')
      const created = await sessionController.create({ workspaceId: workspace.id, sessionId: dirId })
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : undefined
      if (sessionId === undefined) throw new Error('session controller returned no sessionId')
    } catch (error) {
      if (workspace?.id !== undefined) await Promise.resolve(registry.delete(workspace.id)).catch(() => {})
      await store.removeEmptyDir(dir)
      throw error
    }
    if (sessionId !== dirId) log(`session id ${sessionId} differs from requested ${dirId}; keeping directory, recording mapping`)
    const cwd = typeof workspace.path === 'string' ? workspace.path : dir
    await store.writeMeeting({ sessionId, cwd, tempWorkspaceId: workspace.id, settled: false, createdAt: new Date().toISOString() })
    pending.add(sessionId)
    return { sessionId, cwd, reused: false }
  }

  /**
   * Startup: settle sessions that started a turn while the plugin was not
   * listening, and re-arm the in-memory pending index for the rest.
   */
  async function sweep() {
    const meetings = (await store.listMeetings()).filter(m => m.settled !== true)
    if (meetings.length === 0) return
    const known = await summaries()
    for (const meeting of meetings) {
      const summary = known?.get(meeting.sessionId)
      if (summary?.blank === false) await serial(() => settleNow(meeting.sessionId))
      else pending.add(meeting.sessionId)
    }
  }

  return {
    create: () => serial(createNow),
    onTurnStart,
    sweep,
    settle: sessionId => serial(() => settleNow(sessionId)),
    isPending: sessionId => pending.has(sessionId),
  }
}
