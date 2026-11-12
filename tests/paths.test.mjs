import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { inferRoot, slugify, validateTarget } from '../lib/paths.js'
import { sandbox } from './helpers.mjs'

test('slugify', () => {
  assert.equal(slugify('My Cool Project!'), 'my-cool-project')
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu')
  assert.equal(slugify('家庭账本'), '')
  assert.equal(slugify('账本 v2'), 'v2')
})

test('inferRoot prefers a common parent, then the newest workspace, then the default', () => {
  const dshHome = '/h/.dsh'
  assert.deepEqual(
    inferRoot({ workspaces: [{ path: '/h/x/a' }, { path: '/h/code/a' }, { path: '/h/code/b' }], dshHome, defaultRoot: '/d' }),
    { root: '/h/code', source: 'common-parent' },
  )
  assert.deepEqual(
    inferRoot({ workspaces: [{ path: '/h/.dsh/chat' }, { path: '/h/x/a' }, { path: '/h/y/b' }], dshHome, defaultRoot: '/d' }),
    { root: '/h/x', source: 'recent-parent' },
  )
  assert.deepEqual(inferRoot({ workspaces: [{ path: '/h/.dsh/chat' }], dshHome, defaultRoot: '/d' }), { root: '/d', source: 'default-root' })
})

test('validateTarget rejections', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const opts = { dshHome: box.dshHome, home: box.home }
  const reject = (target, code, extra = {}) => assert.rejects(validateTarget(target, { ...opts, ...extra }), { code })

  await reject('relative/dir', 'path-not-absolute')
  await reject(`${box.code}/../escape`, 'path-dotdot')
  await reject('/', 'path-is-root')
  await reject(box.home, 'path-is-home')
  await reject(path.join(box.dshHome, 'inbox', 'x'), 'path-in-dsh-home')
  await reject('/etc/myproj', 'path-forbidden')

  await fs.promises.writeFile(path.join(box.code, 'file'), 'x')
  await reject(path.join(box.code, 'file'), 'path-not-directory')

  await fs.promises.mkdir(path.join(box.code, 'full'))
  await fs.promises.writeFile(path.join(box.code, 'full', 'a'), 'x')
  await reject(path.join(box.code, 'full'), 'path-not-empty')

  // Final component is a symlink.
  await fs.promises.symlink(path.join(box.code, 'full'), path.join(box.code, 'link'))
  await reject(path.join(box.code, 'link'), 'path-symlink')

  // Ancestor symlink pointing into DSH data.
  await fs.promises.symlink(box.dshHome, path.join(box.code, 'sneaky'))
  await reject(path.join(box.code, 'sneaky', 'proj'), 'path-in-dsh-home')

  await fs.promises.mkdir(path.join(box.code, 'reg'))
  await reject(path.join(box.code, 'reg'), 'path-registered', { workspaces: [{ id: 'w', path: path.join(box.code, 'reg') }] })
})

test('validateTarget accepts new and empty dirs and warns on nesting', async t => {
  const box = await sandbox()
  t.after(box.cleanup)
  const fresh = await validateTarget(path.join(box.code, 'new', 'deep'), { dshHome: box.dshHome, home: box.home })
  assert.equal(fresh.exists, false)
  assert.equal(fresh.canonical, path.join(box.code, 'new', 'deep'))
  await fs.promises.mkdir(path.join(box.code, 'empty'))
  assert.equal((await validateTarget(path.join(box.code, 'empty'), { dshHome: box.dshHome, home: box.home })).exists, true)
  const nested = await validateTarget(path.join(box.code, 'parent', 'child'), {
    dshHome: box.dshHome, home: box.home, workspaces: [{ id: 'p', path: box.code }],
  })
  assert.deepEqual(nested.warnings, ['path-nested-workspace'])
})
