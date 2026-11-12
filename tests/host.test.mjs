import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { createInboxSessions } from '../lib/inbox-session.js'
import { createHandlers, ROUTES } from '../lib/routes.js'
import { StateStore } from '../lib/store.js'
import { createProposeTool } from '../lib/tool.js'
import { fakeRegistry, sandbox, setup } from './helpers.mjs'

function fakeSessions() {
  const summaries = new Map()
  return {
    summaries,
    calls: [],
    async create(request) {
      this.calls.push(request)
      summaries.set(request.sessionId, { sessionId: request.sessionId, blank: true })
      return { sessionId: request.sessionId }
    },
    async list() { return { items: [...summaries.values()] } },
  }
}

function lifecycle(box, overrides = {}) {
  const store = new StateStore({ dshHome: box.dshHome })
  const registry = fakeRegistry()
  registry.get = id => registry.items.find(item => item.id === id)
  registry.delete = async id => {
    const index = registry.items.findIndex(item => item.id === id)
    if (index >= 0) registry.items.splice(index, 1)
    return index >= 0
  }
  const sessionController = overrides.sessionController ?? fakeSessions()
  const sessions = createInboxSessions({ store, sessionController, registry, log: () => {} })
  return { store, registry, sessionController, sessions }
}

test('new chat: blank session sits in a temporary workspace on its own meeting dir', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const { store, registry, sessionController, sessions } = lifecycle(box)
  const { sessionId, cwd, reused } = await sessions.create()
  assert.equal(reused, false)
  assert.equal(sessionController.calls[0].workspaceId, 'ws-1')
  assert.equal(sessionController.calls[0].cwd, undefined)
  assert.equal(registry.items[0].path, cwd)
  assert.equal(registry.items[0].title, '新对话')
  assert.equal((await fs.promises.stat(cwd)).mode & 0o777, 0o700)
  const meeting = await store.loadMeeting(sessionId)
  assert.equal(meeting.tempWorkspaceId, 'ws-1')
  assert.equal(meeting.settled, false)
})

test('a second click reuses the still-blank Inbox session', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const { registry, sessions } = lifecycle(box)
  const first = await sessions.create()
  const second = await sessions.create()
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.reused, true)
  assert.equal(registry.items.length, 1)
})

test('first turn/start settles: temporary workspace removed, cwd kept, next click creates new', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const { store, registry, sessionController, sessions } = lifecycle(box)
  const first = await sessions.create()
  assert.equal(sessions.onTurnStart('someone-else'), undefined)
  await sessions.onTurnStart(first.sessionId)
  assert.equal(registry.items.length, 0)
  const meeting = await store.loadMeeting(first.sessionId)
  assert.equal(meeting.settled, true)
  assert.equal(meeting.tempWorkspaceId, undefined)
  assert.equal(meeting.cwd, first.cwd)
  assert.equal(await fs.promises.stat(first.cwd).then(s => s.isDirectory()), true)

  sessionController.summaries.get(first.sessionId).blank = false
  const second = await sessions.create()
  assert.notEqual(second.sessionId, first.sessionId)
})

test('startup sweep settles sessions that started a turn while unobserved', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const env = lifecycle(box)
  const first = await env.sessions.create()
  env.sessionController.summaries.get(first.sessionId).blank = false
  const restarted = createInboxSessions({ store: env.store, sessionController: env.sessionController, registry: env.registry, log: () => {} })
  await restarted.sweep()
  assert.equal(env.registry.items.length, 0)
  assert.equal((await env.store.loadMeeting(first.sessionId)).settled, true)
})

test('creation failure rolls back the temporary workspace and meeting dir', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const { registry, sessions } = lifecycle(box, { sessionController: { async create() { throw new Error('boom') }, async list() { return { items: [] } } } })
  await assert.rejects(sessions.create(), /boom/)
  assert.equal(registry.items.length, 0)
  assert.deepEqual(await fs.promises.readdir(path.join(box.dshHome, 'inbox')), [])
})

test('settled Inbox session can propose; its cwd is the meeting dir', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const { store, sessions } = lifecycle(box)
  const { sessionId, cwd } = await sessions.create()
  await sessions.onTurnStart(sessionId)
  assert.equal((await store.loadMeeting(sessionId)).cwd, cwd)
})

test('tool uses the calling agent id and exposes presentation meta', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const tool = createProposeTool(env.service)
  const value = await tool.execute({ title: 'Demo', path: path.join(env.code, 'demo') }, { agent: { id: env.sessionId } })
  assert.deepEqual(tool.output.presentationMeta({}, value), { dshInbox: { sessionId: env.sessionId, proposalId: value.proposalId } })
  assert.match(tool.output.render({}, value)[0].text, /not created yet/)
  await assert.rejects(tool.execute({ title: 'Demo' }, {}), /conversation/)
})

test('routes validate ids and map errors to statuses', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const handlers = createHandlers({ service: env.service, createSession: async () => ({}) })
  const get = query => handlers.proposal(new Request(`http://x${ROUTES.proposal}?${new URLSearchParams(query)}`))
  const post = (handler, body) => handler(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }))

  assert.equal((await get({ sessionId: '../etc', proposalId: 'p_aaaaaaaaaaaaaaaaaaaaaaaaaa' })).status, 400)
  assert.equal((await get({ sessionId: env.sessionId, proposalId: '../../x' })).status, 400)
  assert.equal((await get({ sessionId: env.sessionId, proposalId: 'p_aaaaaaaaaaaaaaaaaaaaaaaaaa' })).status, 404)

  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'demo') })
  // Cross-session access does not find it.
  assert.equal((await get({ sessionId: '5e40d8e8-4b85-4ed8-97fd-e9bae9793efb', proposalId: out.proposalId })).status, 404)
  const view = await (await get({ sessionId: env.sessionId, proposalId: out.proposalId })).json()
  assert.equal(view.state, 'proposed')
  assert.equal(view.snapshot, undefined)
  assert.equal(typeof view.brief, 'string')

  await env.writeDraft('changed')
  const conflict = await post(handlers.create, { sessionId: env.sessionId, proposalId: out.proposalId })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'draft-changed')
  assert.equal((await post(handlers.repropose, { sessionId: env.sessionId, proposalId: out.proposalId })).status, 200)
  const created = await post(handlers.create, { sessionId: env.sessionId, proposalId: out.proposalId })
  assert.equal(created.status, 200)
  assert.equal((await created.json()).workspaceId, 'ws-1')

  const bad = await handlers.create(new Request('http://x/', { method: 'POST', body: '[1]' }))
  assert.equal(bad.status, 400)
})

test('apply registers tool, routes and the optional skill sub-plugin', () => {
  const effects = []
  const registered = { tools: [], routes: [], plugins: [] }
  const ctx = {
    effect: (fn) => effects.push(fn()),
    tools: { register: def => { registered.tools.push(def.name); return () => {} } },
    connection: { fetch: { register: route => { registered.routes.push(route.path); return () => {} } } },
    workspaceRegistry: { list: () => [], create: async () => ({ id: 'w' }) },
    sessionController: { create: async () => ({ sessionId: 's' }), list: async () => ({ items: [] }) },
    plugin: p => registered.plugins.push(p),
    on: (name, fn) => { registered.events = [...(registered.events ?? []), name]; return () => {} },
  }
  apply(ctx, {})
  assert.deepEqual(registered.tools, ['project_propose'])
  assert.deepEqual(registered.routes.sort(), Object.values(ROUTES).sort())
  assert.equal(registered.plugins[0].inject[0], 'skills')
  assert.deepEqual(registered.events, ['session/event'])
})
