/**
 * Plugin-owned state under `$DSH_HOME/inbox-state/<sessionId>/`.
 *
 * This directory is never any session's cwd, so under the `workspace-write`
 * sandbox the agent cannot rewrite proposals, snapshots or hashes. Agent-written
 * drafts live in the meeting directory (`$DSH_HOME/inbox/<dirId>/`) instead.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { InboxError } from './errors.js'
import { isWithin } from './paths.js'

/** Session ids are opaque to us, but must be a single safe path segment. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** `p_` + 26 base32 characters (128+ bits of randomness). */
export const PROPOSAL_ID_RE = /^p_[a-z2-7]{26}$/

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** New random proposal id. */
export function newProposalId() {
  const bytes = crypto.randomBytes(26)
  let out = 'p_'
  for (const byte of bytes) out += BASE32[byte & 31]
  return out
}

/** sha256 hex of a UTF-8 string. */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Write JSON atomically (tmp + fsync + rename). Overwriting our own state file is intended. */
export async function writeJsonAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.promises.open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.promises.rename(tmp, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export class StateStore {
  /** @param {{ dshHome: string }} options */
  constructor({ dshHome }) {
    this.dshHome = dshHome
    this.inboxRoot = path.join(dshHome, 'inbox')
    this.stateRoot = path.join(dshHome, 'inbox-state')
  }

  assertSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      throw new InboxError('bad-session-id', 'Invalid session id.', 400)
    }
  }

  assertProposalId(proposalId) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)) {
      throw new InboxError('bad-proposal-id', 'Invalid proposal id.', 400)
    }
  }

  sessionDir(sessionId) {
    this.assertSessionId(sessionId)
    return path.join(this.stateRoot, sessionId)
  }

  meetingFile(sessionId) {
    return path.join(this.sessionDir(sessionId), 'meeting.json')
  }

  proposalsDir(sessionId) {
    return path.join(this.sessionDir(sessionId), 'proposals')
  }

  proposalFile(sessionId, proposalId) {
    this.assertProposalId(proposalId)
    return path.join(this.proposalsDir(sessionId), `${proposalId}.json`)
  }

  /** Create the meeting (cwd) directory for a new Inbox session. */
  async createMeetingDir(dirId) {
    this.assertSessionId(dirId)
    await fs.promises.mkdir(this.inboxRoot, { recursive: true, mode: 0o700 })
    const dir = path.join(this.inboxRoot, dirId)
    await fs.promises.mkdir(dir, { mode: 0o700 })
    return dir
  }

  async removeEmptyDir(dir) {
    try {
      await fs.promises.rmdir(dir)
    } catch {
      // Not empty or already gone: leave it.
    }
  }

  async saveMeeting(sessionId, cwd) {
    await this.writeMeeting({ sessionId, cwd, settled: true, createdAt: new Date().toISOString() })
  }

  /** Write the whole meeting record (`sessionId`, `cwd`, optional `tempWorkspaceId`, `settled`). */
  async writeMeeting(meeting) {
    await fs.promises.mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(this.meetingFile(meeting.sessionId), meeting)
  }

  /** All valid meeting records. */
  async listMeetings() {
    let names
    try {
      names = await fs.promises.readdir(this.stateRoot)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const meetings = []
    for (const name of names) {
      const meeting = await this.loadMeeting(name)
      if (meeting !== undefined) meetings.push(meeting)
    }
    return meetings
  }

  /** @returns {Promise<{ sessionId: string, cwd: string } | undefined>} */
  async loadMeeting(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return undefined
    const meeting = await readJson(this.meetingFile(sessionId))
    if (meeting === undefined || meeting.sessionId !== sessionId || typeof meeting.cwd !== 'string') return undefined
    return meeting
  }

  /** Load one proposal, verifying containment and that the stored ids match the request. */
  async loadProposal(sessionId, proposalId) {
    const file = this.proposalFile(sessionId, proposalId)
    let real
    try {
      real = await fs.promises.realpath(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const realRoot = await fs.promises.realpath(this.stateRoot)
    if (!isWithin(real, realRoot)) return undefined
    const record = await readJson(real)
    if (record === undefined || record.id !== proposalId || record.sessionId !== sessionId) return undefined
    return record
  }

  async saveProposal(record) {
    await writeJsonAtomic(this.proposalFile(record.sessionId, record.id), record)
  }

  async listProposals(sessionId) {
    let names
    try {
      names = await fs.promises.readdir(this.proposalsDir(sessionId))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const name of names) {
      const match = /^(p_[a-z2-7]{26})\.json$/.exec(name)
      if (match === null) continue
      const record = await this.loadProposal(sessionId, match[1])
      if (record !== undefined) records.push(record)
    }
    return records
  }
}
