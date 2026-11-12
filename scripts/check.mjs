// Repository hygiene checks run in CI: package `files` exist, no absolute home paths leak.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
let failed = false
const fail = message => { console.error(`✗ ${message}`); failed = true }

for (const entry of pkg.files) {
  if (entry.includes('*')) {
    const dir = path.join(root, path.dirname(entry))
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) fail(`files entry matches nothing: ${entry}`)
  } else if (!fs.existsSync(path.join(root, entry))) {
    fail(`files entry missing: ${entry}`)
  }
}

const homePattern = /\/(home|Users)\/(?!me\b|user\b|<)[A-Za-z0-9_.-]+/
const skip = new Set(['node_modules', '.git'])
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full)
    else if (/\.(js|mjs|json|md|yml|yaml|svg)$/.test(name) && name !== 'check.mjs') {
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (homePattern.test(line)) fail(`absolute home path in ${path.relative(root, full)}:${index + 1}`)
      })
    }
  }
}
walk(root)

if (failed) process.exit(1)
console.log('✓ checks passed')
