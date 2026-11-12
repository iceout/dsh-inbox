/**
 * Path inference and validation for new project directories.
 *
 * Pure Node built-ins only. Every check runs twice: once when the agent
 * proposes a project and again when the user clicks "Create", because the
 * filesystem may change in between.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { InboxError } from './errors.js'

/** System locations a project must never be created inside. */
const FORBIDDEN_PREFIXES = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr',
  '/System', '/Library', '/Applications',
]

/** `$DSH_HOME`, or `~/.dsh` when unset. */
export function dshHome(env = process.env) {
  const value = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return value === '' ? path.join(os.homedir(), '.dsh') : path.resolve(value)
}

/** Expand a leading `~` and make the path absolute. */
export function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2))
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : undefined
}

/**
 * ASCII kebab-case slug from a human title. Returns '' when nothing usable
 * remains (for example a purely Chinese title) — callers then require an
 * explicit path instead of guessing a transliteration.
 */
export function slugify(title) {
  if (typeof title !== 'string') return ''
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/** True when `child` is `parent` itself or lies below it. */
export function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isStrictlyWithin(child, parent) {
  return child !== parent && isWithin(child, parent)
}

async function realpathOrSelf(value) {
  try {
    return await fs.promises.realpath(value)
  } catch {
    return path.resolve(value)
  }
}

async function lstatOrUndefined(value) {
  try {
    return await fs.promises.lstat(value)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Canonicalize a requested target without following a symlink at the final
 * component: the nearest existing ancestor is resolved with realpath and the
 * remaining (not yet existing) segments are appended verbatim.
 *
 * @param {string} target absolute path
 * @returns {Promise<{ canonical: string, exists: boolean, entries: string[] }>}
 */
export async function inspectTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new InboxError('path-required', 'A project path is required.')
  }
  if (!path.isAbsolute(target)) {
    throw new InboxError('path-not-absolute', `Path must be absolute: ${target}`)
  }
  if (target.split(/[\\/]+/).includes('..')) {
    throw new InboxError('path-dotdot', `Path must not contain "..": ${target}`)
  }
  const normalized = path.resolve(target)
  const stat = await lstatOrUndefined(normalized)
  if (stat !== undefined) {
    if (stat.isSymbolicLink()) {
      throw new InboxError('path-symlink', `Target is a symbolic link: ${normalized}`)
    }
    if (!stat.isDirectory()) {
      throw new InboxError('path-not-directory', `Target exists and is not a directory: ${normalized}`)
    }
    const canonical = await fs.promises.realpath(normalized)
    const entries = await fs.promises.readdir(normalized)
    return { canonical, exists: true, entries }
  }
  let ancestor = path.dirname(normalized)
  const rest = [path.basename(normalized)]
  for (;;) {
    const ancestorStat = await lstatOrUndefined(ancestor)
    if (ancestorStat !== undefined) break
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    rest.unshift(path.basename(ancestor))
    ancestor = parent
  }
  const realAncestor = await realpathOrSelf(ancestor)
  return { canonical: path.join(realAncestor, ...rest), exists: false, entries: [] }
}

/**
 * Full validation of a project target.
 *
 * @param {string} target requested absolute path
 * @param {object} options
 * @param {string} options.dshHome
 * @param {string} [options.home]
 * @param {Array<{ id: string, path: string, title?: string }>} [options.workspaces]
 * @param {(name: string) => boolean} [options.allowEntry] entries tolerated in an existing dir (adoption)
 * @param {boolean} [options.allowRegistered] accept an already-registered workspace at the same path (adoption)
 * @returns {Promise<{ canonical: string, exists: boolean, entries: string[], registered?: { id: string }, warnings: string[] }>}
 */
export async function validateTarget(target, options) {
  const info = await inspectTarget(target)
  const { canonical } = info
  const home = await realpathOrSelf(options.home ?? os.homedir())
  const dataHome = await realpathOrSelf(options.dshHome)
  const warnings = []

  if (path.dirname(canonical) === canonical) {
    throw new InboxError('path-is-root', 'Refusing to create a project at the filesystem root.')
  }
  if (canonical === home) {
    throw new InboxError('path-is-home', 'Refusing to use the home directory itself as a project.')
  }
  if (isWithin(canonical, dataHome) || isWithin(canonical, path.resolve(options.dshHome))) {
    throw new InboxError('path-in-dsh-home', `Projects must not live inside DSH data (${options.dshHome}).`)
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (isWithin(canonical, prefix)) {
      throw new InboxError('path-forbidden', `Refusing to create a project under system directory ${prefix}.`)
    }
  }

  if (info.exists) {
    const foreign = info.entries.filter(name => !(options.allowEntry?.(name) ?? false))
    if (foreign.length > 0) {
      throw new InboxError('path-not-empty', `Target directory is not empty: ${canonical}`)
    }
  }

  let registered
  for (const workspace of options.workspaces ?? []) {
    if (typeof workspace?.path !== 'string') continue
    const workspacePath = await realpathOrSelf(workspace.path)
    if (workspacePath === canonical) {
      registered = { id: String(workspace.id) }
    } else if (isStrictlyWithin(canonical, workspacePath)) {
      if (!warnings.includes('path-nested-workspace')) warnings.push('path-nested-workspace')
    }
  }
  if (registered !== undefined && options.allowRegistered !== true) {
    throw new InboxError('path-registered', `A workspace is already registered at ${canonical}.`)
  }

  return { ...info, ...(registered === undefined ? {} : { registered }), warnings }
}

/**
 * Default parent directory for a new project when the agent gives no path.
 *
 * 1. a parent shared by at least two existing workspaces (the most common one);
 * 2. otherwise the parent of the first listed workspace (the registry lists newest first);
 * 3. otherwise the configured default root.
 * Workspaces inside DSH data (for example a chat workspace) never count.
 *
 * @returns {{ root: string, source: 'common-parent' | 'recent-parent' | 'default-root' }}
 */
export function inferRoot({ workspaces = [], dshHome: dataHome, defaultRoot }) {
  const parents = []
  for (const workspace of workspaces) {
    if (typeof workspace?.path !== 'string' || !path.isAbsolute(workspace.path)) continue
    if (dataHome !== undefined && isWithin(path.resolve(workspace.path), path.resolve(dataHome))) continue
    parents.push(path.dirname(path.resolve(workspace.path)))
  }
  const counts = new Map()
  for (const parent of parents) counts.set(parent, (counts.get(parent) ?? 0) + 1)
  let best
  for (const parent of parents) {
    const count = counts.get(parent)
    if (count >= 2 && (best === undefined || count > counts.get(best))) best = parent
  }
  if (best !== undefined) return { root: best, source: 'common-parent' }
  if (parents.length > 0) return { root: parents[0], source: 'recent-parent' }
  return { root: defaultRoot, source: 'default-root' }
}
