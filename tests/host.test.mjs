import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply, createSessionFactory } from '../lib/index.js'
import { createHandlers, ROUTES } from '../lib/routes.js'
import { StateStore } from '../lib/store.js'
import { createProposeTool } from '../lib/tool.js'
import { sandbox, setup } from './helpers.mjs'

test('session factory: meeting dir + mapping; never renames on id mismatch', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const store = new StateStore({ dshHome: box.dshHome })
  const calls = []
  const make = createSessionFactory({
    store,
    sessionController: { async create(request) { calls.push(request); return { sessionId: 'other-id' } } },
    log: () => {},
  })
  const { sessionId, cwd } = await make()
  assert.equal(sessionId, 'other-id')
  assert.equal(calls[0].cwd, cwd)
  assert.equal(calls[0].workspaceId, undefined)
  assert.equal(path.basename(cwd), calls[0].sessionId, 'directory keeps the requested id')
  assert.equal((await fs.promises.stat(cwd)).mode & 0o777, 0o700)
  assert.deepEqual((await store.loadMeeting('other-id')).cwd, cwd)
})

test('session factory removes the empty meeting dir when creation fails', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const store = new StateStore({ dshHome: box.dshHome })
  const make = createSessionFactory({ store, sessionController: { async create() { throw new Error('boom') } }, log: () => {} })
  await assert.rejects(make(), /boom/)
  assert.deepEqual(await fs.promises.readdir(path.join(box.dshHome, 'inbox')), [])
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
    sessionController: { create: async () => ({ sessionId: 's' }) },
    plugin: p => registered.plugins.push(p),
  }
  apply(ctx, {})
  assert.deepEqual(registered.tools, ['project_propose'])
  assert.deepEqual(registered.routes.sort(), Object.values(ROUTES).sort())
  assert.equal(registered.plugins[0].inject[0], 'skills')
})
