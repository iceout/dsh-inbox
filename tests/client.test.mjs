import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const source = await fs.promises.readFile(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/** Load the client bundle with a fake module loader and a minimal React. */
function load() {
  let module
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: v => [v, () => {}],
    useRef: v => ({ current: v }),
    useEffect: () => {},
    useCallback: fn => fn,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: def => { module = def.factory(name => (name === 'react' ? React : undefined)) } } },
    setTimeout, clearTimeout, console, URLSearchParams,
  }
  vm.runInNewContext(source, sandbox)
  return module
}

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    set: next => { value = next; for (const fn of listeners) fn() },
  }
}

test('registers footer entry, the project_propose row and the composer dock', () => {
  const mod = load()
  const registrations = []
  const ctx = {
    effect: fn => fn,
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => registrations.push({ spec, component }) },
  }
  mod.apply(ctx)
  assert.deepEqual(JSON.parse(JSON.stringify(registrations.map(r => r.spec.name))), ['sidebar.footer.action', 'tool.call.toolview', 'conversation.input.dock'])
  assert.equal(registrations[1].spec.key, 'project_propose')
  assert.deepEqual(JSON.parse(JSON.stringify([...mod.inject].sort())), ['locale', 'sessions', 'slots', 'uiWorkspace', 'workspaces'])
})

test('zh and en dictionaries have the same keys', () => {
  const { zh, en } = load().__test
  assert.deepEqual(JSON.stringify(Object.keys(zh).sort()), JSON.stringify(Object.keys(en).sort()))
})

test('proposalRef prefers presentation meta, falls back to result text', () => {
  const { proposalRef: raw } = load().__test
  const proposalRef = props => { const v = raw(props); return v === undefined ? v : JSON.parse(JSON.stringify(v)) }
  const id = 'p_abcdefghijklmnopqrstuvwxyz'
  assert.deepEqual(proposalRef({ block: { meta: { dshInbox: { sessionId: 's', proposalId: id } } } }), { sessionId: 's', proposalId: id })
  assert.deepEqual(proposalRef({ sessionId: 's2', block: { content: [{ type: 'text', text: `Proposal ${id} ready` }] } }), { sessionId: 's2', proposalId: id })
  assert.equal(proposalRef({ block: { content: [] } }), undefined)
})

test('waitFor resolves on a later snapshot and times out otherwise', async () => {
  const { waitFor, workspaceItem } = load().__test
  const list = observable({ items: [] })
  const pending = waitFor(list, s => workspaceItem(s, 'w1'), 1000)
  list.set({ items: [{ workspaceId: 'w1', sessionIds: [] }] })
  assert.equal((await pending).workspaceId, 'w1')
  await assert.rejects(waitFor(observable({ items: [] }), s => workspaceItem(s, 'nope'), 20), /timeout/)
})

test('hasSession understands plain-object and Map byId', () => {
  const { hasSession } = load().__test
  assert.equal(hasSession({ byId: { a: {} } }, 'a'), true)
  assert.equal(hasSession({ byId: new Map([['b', {}]]) }, 'b'), true)
  assert.equal(hasSession({ byId: {} }, 'a'), false)
  assert.equal(hasSession(undefined, 'a'), false)
})
