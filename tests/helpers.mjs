import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { InboxService } from '../lib/proposal.js'
import { StateStore } from '../lib/store.js'

/** A temp sandbox with a fake home, DSH home and project root. */
export async function sandbox() {
  const base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-inbox-')))
  const home = path.join(base, 'home')
  const dshHome = path.join(home, '.dsh')
  const code = path.join(home, 'code')
  await fs.promises.mkdir(dshHome, { recursive: true })
  await fs.promises.mkdir(code, { recursive: true })
  return { base, home, dshHome, code, cleanup: () => fs.promises.rm(base, { recursive: true, force: true }) }
}

/** In-memory workspace registry with the real `create` semantics that matter here. */
export function fakeRegistry(initial = []) {
  const items = [...initial]
  let counter = 0
  return {
    items,
    createCalls: 0,
    list() { return items },
    async create(dir, title) {
      this.createCalls += 1
      const stat = await fs.promises.stat(dir)
      if (!stat.isDirectory()) throw new Error('not a directory')
      const canonical = await fs.promises.realpath(dir)
      const existing = items.find(item => item.path === canonical)
      if (existing !== undefined) return existing
      const workspace = { id: `ws-${++counter}`, path: canonical, title: title ?? path.basename(canonical) }
      items.unshift(workspace)
      return workspace
    },
  }
}

export class Crash extends Error {
  constructor(step) {
    super(`injected crash at ${step}`)
    this.injected = true
  }
}

/** Build a service plus one Inbox session with a meeting dir and drafts. */
export async function setup(options = {}) {
  const box = await sandbox()
  const store = new StateStore({ dshHome: box.dshHome })
  const registry = options.registry ?? fakeRegistry()
  let crashAt = null
  const service = new InboxService({
    store,
    registry,
    dshHome: box.dshHome,
    home: box.home,
    defaultProjectRoot: path.join(box.home, 'projects'),
    fault: step => {
      if (crashAt === step) {
        crashAt = null
        throw new Crash(step)
      }
    },
  })
  const sessionId = '0489bf9f-5a94-4a71-93c7-e963cfd78607'
  const cwd = await store.createMeetingDir(sessionId)
  await store.saveMeeting(sessionId, cwd)
  const brief = `# 目标\n\n${'这是一个测试项目的说明。'.repeat(40)}\n\n## 下一步\n\n- 第一件事\n`
  await fs.promises.writeFile(path.join(cwd, 'BRIEF.draft.md'), brief)
  return {
    ...box,
    store,
    registry,
    service,
    sessionId,
    cwd,
    brief,
    crashNext: step => { crashAt = step },
    writeDraft: text => fs.promises.writeFile(path.join(cwd, 'BRIEF.draft.md'), text),
  }
}
