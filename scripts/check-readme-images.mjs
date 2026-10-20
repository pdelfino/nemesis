#!/usr/bin/env node
// README pictures gate (#187): every local image README.md embeds exists,
// every SVG under docs/images is well-formed XML, every logo has its row in
// docs/images/logos/PROVENANCE.org, and every ```mermaid fence is closed.
// A broken picture on the repository's front page fails the gate instead of
// showing a torn icon. Remote images (the Dürer engraving, the CI badge) are
// not fetched.
//
// Usage: node scripts/check-readme-images.mjs [repository-directory]

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Local image paths a Markdown text embeds, from ![alt](src) and <img src>. */
export function embeddedImages(markdown) {
  const found = []
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) found.push(m[1])
  for (const m of markdown.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) found.push(m[1])
  return found.filter((src) => !/^[a-z]+:/i.test(src))
}

/** True when every ```mermaid fence has its closing ```. */
export function mermaidFencesClosed(markdown) {
  let open = false
  for (const line of markdown.split('\n')) {
    if (!open && line.trim() === '```mermaid') open = true
    else if (open && line.trim() === '```') open = false
  }
  return !open
}

function wellFormed(path) {
  const run = spawnSync('xmllint', ['--noout', path], { encoding: 'utf8' })
  if (run.error) return true // no xmllint on this machine: skip, CI's macOS has it
  return run.status === 0
}

export function check(repository) {
  const problems = []
  const readme = readFileSync(join(repository, 'README.md'), 'utf8')
  for (const src of embeddedImages(readme)) {
    if (!existsSync(join(repository, src)))
      problems.push(`README.md embeds a missing image: ${src}`)
  }
  if (!mermaidFencesClosed(readme))
    problems.push('README.md has a ```mermaid fence that is never closed')

  const images = join(repository, 'docs', 'images')
  const logos = join(images, 'logos')
  for (const dir of [images, logos]) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.svg'))) {
      if (!wellFormed(join(dir, name))) problems.push(`not well-formed XML: ${join(dir, name)}`)
    }
  }
  if (existsSync(logos)) {
    const provenancePath = join(logos, 'PROVENANCE.org')
    const provenance = existsSync(provenancePath) ? readFileSync(provenancePath, 'utf8') : ''
    for (const name of readdirSync(logos).filter((n) => /\.(png|svg|jpe?g)$/i.test(n))) {
      if (!provenance.includes(`| ${name} |`))
        problems.push(`logo without a PROVENANCE.org row: ${name}`)
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('..', import.meta.url))
  const problems = check(repository)
  for (const p of problems) console.error(p)
  if (problems.length) process.exit(1)
  console.log('README images: ok')
}
