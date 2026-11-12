import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { AGENTS_POINTER } from '../lib/proposal.js'
import { setup } from './helpers.mjs'

const exists = file => fs.promises.access(file).then(() => true, () => false)

test('propose → create writes snapshot, AGENTS pointer and registers once', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const target = path.join(env.code, 'demo')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: target })
  assert.equal(out.path, target)
  assert.deepEqual(out.files, ['BRIEF.md', 'AGENTS.md'])
  assert.equal(await exists(target), false, 'propose must not touch the project path')

  const result = await env.service.create(env.sessionId, out.proposalId)
  assert.equal(result.workspaceId, 'ws-1')
  assert.equal(await fs.promises.readFile(path.join(target, 'BRIEF.md'), 'utf8'), env.brief)
  assert.equal(await fs.promises.readFile(path.join(target, 'AGENTS.md'), 'utf8'), AGENTS_POINTER)
  assert.deepEqual((await fs.promises.readdir(target)).sort(), ['AGENTS.md', 'BRIEF.md'])

  const again = await env.service.create(env.sessionId, out.proposalId)
  assert.deepEqual(again, result)
  assert.equal(env.registry.createCalls, 1)
})

test('proposal state lives outside the session cwd', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'demo') })
  const file = env.store.proposalFile(env.sessionId, out.proposalId)
  assert.ok(file.startsWith(path.join(env.dshHome, 'inbox-state')))
  assert.ok(!file.startsWith(env.cwd))
})

test('non-Inbox sessions cannot propose', async t => {
  const env = await setup()
  t.after(env.cleanup)
  await assert.rejects(env.service.propose('5e40d8e8-4b85-4ed8-97fd-e9bae9793efb', { title: 'X', path: path.join(env.code, 'x') }), { code: 'not-inbox-session' })
})

test('draft change after preview → 409, repropose keeps the id and bumps revision', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const target = path.join(env.code, 'demo')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: target })
  await env.writeDraft(`${env.brief}\n补充一条。\n`)

  assert.equal((await env.service.view(env.sessionId, out.proposalId)).draftChanged, true)
  await assert.rejects(env.service.create(env.sessionId, out.proposalId), { code: 'draft-changed' })
  assert.equal(await exists(target), false)

  const view = await env.service.repropose(env.sessionId, out.proposalId)
  assert.equal(view.id, out.proposalId)
  assert.equal(view.revision, 2)
  // "Refresh": a fresh GET of the original id sees the new revision and can create.
  const fresh = await env.service.view(env.sessionId, out.proposalId)
  assert.equal(fresh.revision, 2)
  assert.equal(fresh.draftChanged, false)
  await env.service.create(env.sessionId, out.proposalId)
  assert.match(await fs.promises.readFile(path.join(target, 'BRIEF.md'), 'utf8'), /补充一条/)
})

test('AGENTS.draft.md change is detected too', async t => {
  const env = await setup()
  t.after(env.cleanup)
  await fs.promises.writeFile(path.join(env.cwd, 'AGENTS.draft.md'), '回复用中文。\n')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'demo'), agents: 'draft' })
  await fs.promises.writeFile(path.join(env.cwd, 'AGENTS.draft.md'), '回复用英文。\n')
  assert.equal((await env.service.view(env.sessionId, out.proposalId)).draftChanged, true)
  await assert.rejects(env.service.create(env.sessionId, out.proposalId), { code: 'draft-changed' })
})

test('agents "none" writes only BRIEF.md; unticking AGENTS on the card is honored', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const a = await env.service.propose(env.sessionId, { title: 'A', path: path.join(env.code, 'a'), agents: 'none' })
  await env.service.create(env.sessionId, a.proposalId)
  assert.deepEqual(await fs.promises.readdir(path.join(env.code, 'a')), ['BRIEF.md'])
  const b = await env.service.propose(env.sessionId, { title: 'B', path: path.join(env.code, 'b') })
  await env.service.create(env.sessionId, b.proposalId, { writeAgents: false })
  assert.deepEqual(await fs.promises.readdir(path.join(env.code, 'b')), ['BRIEF.md'])
})

test('a new propose supersedes the open one', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const first = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'one') })
  const second = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'two') })
  assert.equal((await env.service.view(env.sessionId, first.proposalId)).state, 'superseded')
  assert.equal((await env.service.view(env.sessionId, second.proposalId)).state, 'proposed')
  await assert.rejects(env.service.create(env.sessionId, first.proposalId), { code: 'superseded' })
})

for (const step of ['after-intent', 'after-mkdir', 'write:BRIEF.md:after-content', 'write:BRIEF.md:after-link', 'write:AGENTS.md:after-content', 'after-register']) {
  test(`crash at ${step} → card shows interrupted → retry adopts and completes`, async t => {
    const env = await setup()
    t.after(env.cleanup)
    const target = path.join(env.code, 'demo')
    const out = await env.service.propose(env.sessionId, { title: 'Demo', path: target })
    env.crashNext(step)
    await assert.rejects(env.service.create(env.sessionId, out.proposalId), { injected: true })

    const view = await env.service.view(env.sessionId, out.proposalId)
    assert.equal(view.state, 'creating')
    assert.equal(view.interrupted, true)

    // Even if the user edits the draft meanwhile, the recorded intent wins.
    await env.writeDraft('changed after crash')
    const result = await env.service.create(env.sessionId, out.proposalId)
    assert.equal(result.workspaceId, 'ws-1')
    assert.deepEqual((await fs.promises.readdir(target)).sort(), ['AGENTS.md', 'BRIEF.md'])
    assert.equal(await fs.promises.readFile(path.join(target, 'BRIEF.md'), 'utf8'), env.brief)
    assert.equal(env.registry.items.length, 1)
  })
}

test('adoption refuses foreign content', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const target = path.join(env.code, 'demo')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: target })
  env.crashNext('after-mkdir')
  await assert.rejects(env.service.create(env.sessionId, out.proposalId), { injected: true })
  await fs.promises.writeFile(path.join(target, 'notes.txt'), 'someone else')
  await assert.rejects(env.service.create(env.sessionId, out.proposalId), { code: 'path-not-empty' })
  assert.equal((await env.service.view(env.sessionId, out.proposalId)).state, 'failed')
})

test('BRIEF.md appearing with other content after validation is never overwritten', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const target = path.join(env.code, 'demo')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: target })
  await fs.promises.mkdir(target)
  // Empty dir is allowed; simulate a race by dropping a BRIEF.md right after mkdir.
  const original = env.service.fault
  env.service.fault = async step => {
    if (step === 'after-mkdir') await fs.promises.writeFile(path.join(target, 'BRIEF.md'), 'theirs')
    return original(step)
  }
  await assert.rejects(env.service.create(env.sessionId, out.proposalId), { code: 'file-exists' })
  assert.equal(await fs.promises.readFile(path.join(target, 'BRIEF.md'), 'utf8'), 'theirs')
})

test('markOpened is write-once and requires created', async t => {
  const env = await setup()
  t.after(env.cleanup)
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'demo') })
  await assert.rejects(env.service.markOpened(env.sessionId, out.proposalId, 'abc'), { code: 'bad-state' })
  await env.service.create(env.sessionId, out.proposalId)
  assert.deepEqual(await env.service.markOpened(env.sessionId, out.proposalId, 'first'), { projectSessionId: 'first' })
  assert.deepEqual(await env.service.markOpened(env.sessionId, out.proposalId, 'second'), { projectSessionId: 'first' })
  assert.equal((await env.service.view(env.sessionId, out.proposalId)).projectSessionId, 'first')
})

test('soft warnings do not block', async t => {
  const env = await setup()
  t.after(env.cleanup)
  await env.writeDraft('tiny')
  const out = await env.service.propose(env.sessionId, { title: 'Demo', path: path.join(env.code, 'demo') })
  assert.ok(out.warnings.includes('brief-short'))
  await env.service.create(env.sessionId, out.proposalId)
})
