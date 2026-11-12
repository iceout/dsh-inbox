/**
 * Proposal lifecycle: propose → (repropose) → create, with crash-safe adoption.
 *
 * States: proposed → creating → created | failed; proposed/failed → superseded.
 * The agent can only reach `propose`. `repropose`, `create` and `markOpened`
 * are driven by the user clicking the proposal card.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { errorInfo, InboxError } from './errors.js'
import { expandHome, inferRoot, slugify, validateTarget } from './paths.js'
import { newProposalId, sha256 } from './store.js'

export const BRIEF_DRAFT = 'BRIEF.draft.md'
export const AGENTS_DRAFT = 'AGENTS.draft.md'
export const BRIEF_FILE = 'BRIEF.md'
export const AGENTS_FILE = 'AGENTS.md'
export const MAX_DRAFT_BYTES = 256 * 1024
export const MAX_TITLE = 120
export const MAX_KICKOFF = 4000

export const AGENTS_POINTER = '项目背景、已定决策与未决问题见 BRIEF.md。\n\nProject background, decisions and open questions: see BRIEF.md.\n'

export const DEFAULT_KICKOFF = [
  '这是一个项目的启动交接。先读 BRIEF.md，然后：',
  '1. 用不超过 5 行复述目标、范围、关键约束',
  '2. 列出第一批任务和验证方式',
  '3. 列出需要我拍板的问题，先不要开始执行',
].join('\n')

const GOAL_WORDS = ['目标', '问题', '背景', 'goal', 'problem', 'objective', 'why']
const NEXT_WORDS = ['下一步', '第一批', '行动', 'next step', 'next steps', 'first', 'todo', 'action']

/** Soft checks: warnings only, never block creation. */
export function briefWarnings(brief) {
  const warnings = []
  const lower = brief.toLowerCase()
  if (brief.trim().length < 300) warnings.push('brief-short')
  if (!GOAL_WORDS.some(word => lower.includes(word))) warnings.push('brief-missing-goal')
  if (!NEXT_WORDS.some(word => lower.includes(word))) warnings.push('brief-missing-next')
  return warnings
}

async function readDraft(file, label) {
  let stat
  try {
    stat = await fs.promises.lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new InboxError('draft-missing', `${label} not found: ${file}`)
    throw error
  }
  if (!stat.isFile()) throw new InboxError('draft-not-file', `${label} must be a regular file (no symlinks): ${file}`)
  if (stat.size > MAX_DRAFT_BYTES) throw new InboxError('draft-too-large', `${label} exceeds ${MAX_DRAFT_BYTES} bytes.`)
  const text = await fs.promises.readFile(file, 'utf8')
  if (text.trim() === '') throw new InboxError('draft-empty', `${label} is empty.`)
  return text
}

async function hashOrNull(file) {
  try {
    const stat = await fs.promises.lstat(file)
    if (!stat.isFile()) return null
    return sha256(await fs.promises.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function textArg(value, label, max, required) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new InboxError('invalid-args', `${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new InboxError('invalid-args', `${label} must be a string.`)
  const text = value.trim()
  if (text.length > max) throw new InboxError('invalid-args', `${label} must be at most ${max} characters.`)
  return text
}

/** Public projection of a record for the card. */
function viewOf(record, extra) {
  const { snapshot, ...rest } = record
  return {
    ...rest,
    brief: snapshot.brief,
    agents: snapshot.agents,
    files: [BRIEF_FILE, ...(snapshot.agents !== null ? [AGENTS_FILE] : [])],
    ...extra,
  }
}

export class InboxService {
  /**
   * @param {object} deps
   * @param {import('./store.js').StateStore} deps.store
   * @param {{ list(): any[], create(path: string, title?: string): Promise<any> }} deps.registry
   * @param {string} deps.dshHome
   * @param {string} [deps.home]
   * @param {string} [deps.defaultProjectRoot]
   * @param {boolean} [deps.writeAgentsPointer]
   * @param {() => number} [deps.now]
   * @param {(step: string) => (void | Promise<void>)} [deps.fault] test-only crash injection
   * @param {(message: string) => void} [deps.log]
   */
  constructor(deps) {
    this.store = deps.store
    this.registry = deps.registry
    this.dshHome = deps.dshHome
    this.home = deps.home ?? os.homedir()
    this.defaultProjectRoot = expandHome(deps.defaultProjectRoot ?? '~/projects', this.home) ?? path.join(this.home, 'projects')
    this.writeAgentsPointer = deps.writeAgentsPointer !== false
    this.now = deps.now ?? Date.now
    this.fault = deps.fault ?? (() => {})
    this.log = deps.log ?? (() => {})
    /** @type {Map<string, Promise<unknown>>} proposalId → in-flight operation */
    this.locks = new Map()
  }

  workspaces() {
    try {
      const list = this.registry.list()
      return Array.isArray(list) ? list.map(item => ({ id: item.id, path: item.path, title: item.title })) : []
    } catch {
      return []
    }
  }

  iso() {
    return new Date(this.now()).toISOString()
  }

  async withLock(proposalId, fn) {
    while (this.locks.has(proposalId)) {
      try {
        await this.locks.get(proposalId)
      } catch {
        // The previous holder's failure is its own.
      }
    }
    const run = (async () => fn())()
    this.locks.set(proposalId, run)
    try {
      return await run
    } finally {
      this.locks.delete(proposalId)
    }
  }

  async requireMeeting(sessionId) {
    const meeting = await this.store.loadMeeting(sessionId)
    if (meeting === undefined) {
      throw new InboxError('not-inbox-session', 'project_propose is only available in Inbox conversations (started with "New chat").', 403)
    }
    return meeting
  }

  async requireProposal(sessionId, proposalId) {
    const record = await this.store.loadProposal(sessionId, proposalId)
    if (record === undefined) throw new InboxError('proposal-not-found', 'Proposal not found.', 404)
    return record
  }

  /** Read drafts from the meeting dir and build snapshot + hashes. */
  async readSnapshot(cwd, agentsMode) {
    const brief = await readDraft(path.join(cwd, BRIEF_DRAFT), BRIEF_DRAFT)
    let agents = null
    let agentsDraftHash = null
    if (agentsMode === 'draft') {
      const draft = await readDraft(path.join(cwd, AGENTS_DRAFT), AGENTS_DRAFT)
      agents = draft
      agentsDraftHash = sha256(draft)
    } else if (agentsMode === 'pointer' && this.writeAgentsPointer) {
      agents = AGENTS_POINTER
    }
    return {
      snapshot: { brief, agents },
      hash: { brief: sha256(brief), agents: agents === null ? null : sha256(agents), agentsDraft: agentsDraftHash },
    }
  }

  /** Whether either draft changed since the snapshot. */
  async draftChanged(record, cwd) {
    if ((await hashOrNull(path.join(cwd, BRIEF_DRAFT))) !== record.hash.brief) return true
    if (record.agentsMode === 'draft' && (await hashOrNull(path.join(cwd, AGENTS_DRAFT))) !== record.hash.agentsDraft) return true
    return false
  }

  /**
   * Agent tool body. Writes only plugin state; never touches project paths.
   *
   * @param {string} sessionId calling session
   * @param {{ title?: unknown, path?: unknown, kickoff?: unknown, agents?: unknown }} args
   */
  async propose(sessionId, args) {
    const meeting = await this.requireMeeting(sessionId)
    const title = textArg(args?.title, 'title', MAX_TITLE, true)
    const kickoff = textArg(args?.kickoff, 'kickoff', MAX_KICKOFF, false) ?? DEFAULT_KICKOFF
    const agentsMode = args?.agents === undefined || args?.agents === null ? 'pointer' : args.agents
    if (!['pointer', 'draft', 'none'].includes(agentsMode)) {
      throw new InboxError('invalid-args', 'agents must be "pointer", "draft" or "none".')
    }

    const workspaces = this.workspaces()
    let target
    let pathSource
    const explicit = textArg(args?.path, 'path', 4096, false)
    if (explicit !== undefined) {
      target = expandHome(explicit, this.home)
      if (target === undefined) throw new InboxError('path-not-absolute', `Path must be absolute: ${explicit}`)
      pathSource = 'explicit'
    } else {
      const slug = slugify(title)
      if (slug === '') {
        throw new InboxError('slug-unavailable', 'Cannot derive an ASCII directory name from the title; pass an explicit absolute "path".')
      }
      const inferred = inferRoot({ workspaces, dshHome: this.dshHome, defaultRoot: this.defaultProjectRoot })
      target = path.join(inferred.root, slug)
      pathSource = inferred.source
    }

    const checked = await validateTarget(target, { dshHome: this.dshHome, home: this.home, workspaces })
    const { snapshot, hash } = await this.readSnapshot(meeting.cwd, agentsMode)
    const warnings = [...checked.warnings, ...briefWarnings(snapshot.brief)]
    if (workspaces.some(item => item.title === title)) warnings.push('title-duplicate')

    // Older open proposals of this session are replaced by the new one.
    for (const previous of await this.store.listProposals(sessionId)) {
      if (previous.state === 'proposed' || (previous.state === 'failed' && previous.intent === undefined)) {
        await this.withLock(previous.id, async () => {
          const fresh = await this.store.loadProposal(sessionId, previous.id)
          if (fresh !== undefined && (fresh.state === 'proposed' || (fresh.state === 'failed' && fresh.intent === undefined))) {
            await this.store.saveProposal({ ...fresh, state: 'superseded', updatedAt: this.iso() })
          }
        })
      }
    }

    const record = {
      version: 1,
      id: newProposalId(),
      sessionId,
      revision: 1,
      title,
      path: checked.canonical,
      pathSource,
      kickoff,
      agentsMode,
      snapshot,
      hash,
      warnings,
      state: 'proposed',
      createdAt: this.iso(),
      updatedAt: this.iso(),
    }
    await this.store.saveProposal(record)
    this.log(`proposed ${record.id} session=${sessionId} path=${record.path}`)
    return {
      proposalId: record.id,
      sessionId,
      title,
      path: record.path,
      pathSource,
      files: [BRIEF_FILE, ...(snapshot.agents !== null ? [AGENTS_FILE] : [])],
      warnings,
      next: 'A preview card is shown in the conversation. Ask the user to review it and click "Create project". Do not claim the project exists yet.',
    }
  }

  /** Card view: record + live flags. */
  async view(sessionId, proposalId) {
    const record = await this.requireProposal(sessionId, proposalId)
    const meeting = await this.store.loadMeeting(sessionId)
    const draftChanged = meeting !== undefined && (record.state === 'proposed' || record.state === 'failed')
      ? await this.draftChanged(record, meeting.cwd)
      : false
    const interrupted = record.state === 'creating' && !this.locks.has(proposalId)
    return viewOf(record, { draftChanged, interrupted })
  }

  /** Newest non-superseded proposal of an Inbox session, for the composer dock; null when none. */
  async latest(sessionId) {
    this.store.assertSessionId(sessionId)
    if ((await this.store.loadMeeting(sessionId)) === undefined) return null
    const records = (await this.store.listProposals(sessionId)).filter(record => record.state !== 'superseded')
    if (records.length === 0) return null
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return this.view(sessionId, records[0].id)
  }

  /** Re-read the drafts into the same proposal id (revision + 1). */
  async repropose(sessionId, proposalId) {
    return this.withLock(proposalId, async () => {
      const record = await this.requireProposal(sessionId, proposalId)
      if (record.state !== 'proposed' && record.state !== 'failed') {
        throw new InboxError('bad-state', `Cannot re-preview a ${record.state} proposal.`, 409)
      }
      if (record.intent !== undefined) {
        throw new InboxError('bad-state', 'Creation already started; retry it instead of re-previewing.', 409)
      }
      const meeting = await this.requireMeeting(sessionId)
      if (!(await this.draftChanged(record, meeting.cwd))) {
        throw new InboxError('draft-unchanged', 'Drafts have not changed since the preview.', 409)
      }
      const workspaces = this.workspaces()
      const checked = await validateTarget(record.path, { dshHome: this.dshHome, home: this.home, workspaces })
      const { snapshot, hash } = await this.readSnapshot(meeting.cwd, record.agentsMode)
      const warnings = [...checked.warnings, ...briefWarnings(snapshot.brief)]
      if (workspaces.some(item => item.title === record.title)) warnings.push('title-duplicate')
      const { error: _error, ...rest } = record
      const next = { ...rest, snapshot, hash, warnings, revision: record.revision + 1, state: 'proposed', updatedAt: this.iso() }
      await this.store.saveProposal(next)
      return viewOf(next, { draftChanged: false, interrupted: false })
    })
  }

  /** Names a target directory may contain when adopting this proposal's own partial result. */
  productFilter(record, writeAgents) {
    const tmpPrefix = `.dsh-inbox-${record.id}-`
    return name => name === BRIEF_FILE || (writeAgents && name === AGENTS_FILE) || name.startsWith(tmpPrefix)
  }

  /** True when an existing directory only contains this proposal's products with the expected content. */
  async isOwnPartial(dir, record, writeAgents) {
    let stat
    try {
      stat = await fs.promises.lstat(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    if ((await fs.promises.realpath(dir)) !== record.intent.path) return false
    const allowed = this.productFilter(record, writeAgents)
    for (const name of await fs.promises.readdir(dir)) {
      if (!allowed(name)) return false
      if (name === BRIEF_FILE && (await hashOrNull(path.join(dir, name))) !== record.hash.brief) return false
      if (name === AGENTS_FILE && (await hashOrNull(path.join(dir, name))) !== record.hash.agents) return false
    }
    return true
  }

  /**
   * Write one product file without ever overwriting: tmp (wx) + fsync + link.
   * An existing file with the expected hash counts as done.
   */
  async writeProduct(dir, name, content, expectedHash, record) {
    const final = path.join(dir, name)
    const existing = await fs.promises.lstat(final).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (existing !== undefined) {
      if (existing.isFile() && (await hashOrNull(final)) === expectedHash) return
      throw new InboxError('file-exists', `${name} already exists in ${dir} with different content.`, 409)
    }
    const tmp = path.join(dir, `.dsh-inbox-${record.id}-${name}.tmp`)
    const handle = await fs.promises.open(tmp, 'wx', 0o644)
    try {
      await handle.writeFile(content, 'utf8')
      await this.fault(`write:${name}:after-content`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.promises.link(tmp, final)
    await this.fault(`write:${name}:after-link`)
    await fs.promises.unlink(tmp)
    await fsyncDir(dir)
  }

  /**
   * User clicked "Create project" (or "Retry" / "Continue").
   *
   * @param {string} sessionId
   * @param {string} proposalId
   * @param {{ writeAgents?: boolean }} [options]
   */
  async create(sessionId, proposalId, options = {}) {
    return this.withLock(proposalId, async () => {
      let record = await this.requireProposal(sessionId, proposalId)
      if (record.state === 'created') return this.resultOf(record)
      if (record.state === 'superseded') throw new InboxError('superseded', 'This proposal was replaced by a newer one.', 409)

      const hasAgents = record.snapshot.agents !== null
      const writeAgents = record.intent !== undefined
        ? record.intent.writeAgents
        : hasAgents && options.writeAgents !== false

      // 1. Adoption: a previous attempt recorded its intent before touching the project path.
      const adopting = record.intent !== undefined && (await this.isOwnPartial(record.intent.path, record, writeAgents))

      // 2. Without adoption, what was previewed must still be what is on disk.
      if (!adopting) {
        const meeting = await this.requireMeeting(sessionId)
        if (await this.draftChanged(record, meeting.cwd)) {
          throw new InboxError('draft-changed', 'The draft changed after the preview. Re-preview before creating.', 409)
        }
      }

      try {
        // 3. Validate, then record intent before any write to the project path.
        const target = record.intent?.path ?? record.path
        const checked = await validateTarget(target, {
          dshHome: this.dshHome,
          home: this.home,
          workspaces: this.workspaces(),
          allowEntry: adopting ? this.productFilter(record, writeAgents) : name => false,
          allowRegistered: adopting,
        })
        record = {
          ...record,
          state: 'creating',
          intent: record.intent ?? { path: checked.canonical, writeAgents, at: this.iso() },
          updatedAt: this.iso(),
        }
        delete record.error
        await this.store.saveProposal(record)
        await this.fault('after-intent')
        const dir = record.intent.path

        // 4. Clean our own leftovers from an interrupted attempt.
        if (adopting && checked.exists) {
          const prefix = `.dsh-inbox-${record.id}-`
          for (const name of await fs.promises.readdir(dir)) {
            if (name.startsWith(prefix)) await fs.promises.unlink(path.join(dir, name))
          }
        }

        // 5. Directory: parents recursively, the final segment exclusively.
        await fs.promises.mkdir(path.dirname(dir), { recursive: true })
        try {
          await fs.promises.mkdir(dir)
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
          const stat = await fs.promises.lstat(dir)
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new InboxError('path-symlink', `Target changed into a non-directory or symlink: ${dir}`)
          }
          if (!adopting && (await fs.promises.readdir(dir)).length > 0) {
            throw new InboxError('path-not-empty', `Target directory is not empty: ${dir}`)
          }
        }
        await this.fault('after-mkdir')

        // 6. Files.
        await this.writeProduct(dir, BRIEF_FILE, record.snapshot.brief, record.hash.brief, record)
        if (writeAgents) await this.writeProduct(dir, AGENTS_FILE, record.snapshot.agents, record.hash.agents, record)

        // 7. The directory must still be where we validated it.
        if ((await fs.promises.realpath(dir)) !== dir) {
          throw new InboxError('path-changed', `Target was replaced during creation: ${dir}`)
        }

        // 8. Register (idempotent for the same canonical path).
        let workspaceId = checked.registered?.id
        if (workspaceId === undefined) {
          const workspace = await this.registry.create(dir, record.title)
          workspaceId = typeof workspace?.id === 'string' ? workspace.id : undefined
          if (workspaceId === undefined) throw new InboxError('register-failed', 'Workspace registry returned no id.')
        }
        await this.fault('after-register')

        record = { ...record, state: 'created', workspaceId, createdProjectAt: this.iso(), updatedAt: this.iso() }
        await this.store.saveProposal(record)
        this.log(`created ${record.id} path=${dir} workspace=${workspaceId}`)
        return this.resultOf(record)
      } catch (error) {
        if (error?.injected === true) throw error // simulated crash: leave state as-is
        const failed = { ...record, state: 'failed', error: errorInfo(error), updatedAt: this.iso() }
        await this.store.saveProposal(failed).catch(() => {})
        this.log(`create failed ${record.id}: ${failed.error.code} ${failed.error.message}`)
        throw error
      }
    })
  }

  resultOf(record) {
    return {
      workspaceId: record.workspaceId,
      path: record.intent?.path ?? record.path,
      briefPath: path.join(record.intent?.path ?? record.path, BRIEF_FILE),
      kickoff: record.kickoff,
      projectSessionId: record.projectSessionId ?? null,
    }
  }

  /** Remember the first project session opened after creation (write-once). */
  async markOpened(sessionId, proposalId, projectSessionId) {
    if (typeof projectSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectSessionId)) {
      throw new InboxError('bad-session-id', 'Invalid project session id.', 400)
    }
    return this.withLock(proposalId, async () => {
      const record = await this.requireProposal(sessionId, proposalId)
      if (record.state !== 'created') throw new InboxError('bad-state', 'Proposal is not created yet.', 409)
      if (typeof record.projectSessionId === 'string') return { projectSessionId: record.projectSessionId }
      await this.store.saveProposal({ ...record, projectSessionId, updatedAt: this.iso() })
      return { projectSessionId }
    })
  }
}

async function fsyncDir(dir) {
  let handle
  try {
    handle = await fs.promises.open(dir, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unsupported on some platforms; the link itself is atomic.
  } finally {
    await handle?.close().catch(() => {})
  }
}
