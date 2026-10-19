#!/usr/bin/env node
// Supply chain gate (SECURITY.org T5, docs/adr/0001-dependencies.org): no
// installed dependency may run code at install time. Electron is an exception,
// because it downloads its own binary, and the install path runs that installer
// explicitly after `npm ci --ignore-scripts`. electron-winstaller (pulled in by
// electron-builder) is the other: its script only picks a 7-Zip binary for
// Windows installers, it never runs under `--ignore-scripts`, and Nemesis
// builds no Windows installer (#35).
//
// Usage: node scripts/check-deps.mjs [node_modules-directory]

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall']
const ALLOWED = new Set(['electron', 'electron-winstaller'])

const repository = fileURLToPath(new URL('..', import.meta.url))
const modules = process.argv[2] ? resolve(process.argv[2]) : join(repository, 'node_modules')

function packageDirectories(nodeModules) {
  const directories = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) directories.push(join(path, scoped.name))
      }
      continue
    }
    directories.push(path)
  }
  return directories
}

function inspect(nodeModules, found) {
  for (const directory of packageDirectories(nodeModules)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      found.inspected += 1
      const { name, scripts } = JSON.parse(readFileSync(manifest, 'utf8'))
      const declared = LIFECYCLE_SCRIPTS.filter((script) => scripts?.[script])
      const where = relative(process.cwd(), directory)
      if (declared.length > 0 && !ALLOWED.has(name)) {
        found.offenders.push({ name: name ?? where, where, declared })
      }
    }
    const nested = join(directory, 'node_modules')
    if (existsSync(nested)) inspect(nested, found)
  }
}

if (!existsSync(modules)) {
  console.error(`check-deps: ${modules} is missing. Run \`npm ci --ignore-scripts\` first.`)
  process.exit(1)
}

const found = { inspected: 0, offenders: [] }
inspect(modules, found)

if (found.offenders.length > 0) {
  console.error(
    `check-deps: ${found.offenders.length} dependency lifecycle script(s) found. SECURITY.org T5 forbids them.`,
  )
  for (const offender of found.offenders) {
    console.error(`  ${offender.name} (${offender.where}): ${offender.declared.join(', ')}`)
  }
  console.error(
    `Drop the dependency, or vendor what it builds. Only ${[...ALLOWED].join(', ')} are allowed one.`,
  )
  process.exit(1)
}

console.log(
  `check-deps: ${found.inspected} installed packages, no lifecycle scripts outside ${[...ALLOWED].join(', ')}.`,
)
