#!/usr/bin/env node
/**
 * Publish the host's authoritative guides into this independently usable plugin repository.
 *
 *   host docs/site/plugin/*.md  ->  docs/developer/                      (web / human reading copy)
 *                                ->  skills/enest-development/references/ (self-contained AI skill)
 *
 * The host stays the single editing point for every guide it owns. Guides that only exist here
 * (repository SOPs) are registered in `localGuides` so the skill carries them without the host
 * site pretending to own them.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--host-root')
const host = resolve(flag >= 0 ? process.argv[flag + 1] : join(repository, '..'))
const source = join(host, 'docs/site/plugin'), developer = join(repository, 'docs/developer')
const skill = join(repository, 'skills/enest-development/references')
const check = process.argv.includes('--check')
/** Plugin-repository-only guides: never written by the host, carried by both targets. */
const localGuides = ['react-migration-sop.md']
const files = (await readdir(source)).filter(name => name.endsWith('.md') && !name.startsWith('_')).sort()
if (!check) {
  await mkdir(developer, { recursive: true })
  await mkdir(skill, { recursive: true })
}
// A local guide is edited in docs/developer; it is only copied from there into the skill.
for (const name of localGuides) {
  if (await readFile(join(developer, name), 'utf8').catch(() => null) === null) throw new Error(`Missing local guide: ${join(developer, name)}`)
}
let stale = false
const sync = async (target, file, expected) => {
  const path = join(target, file)
  if (check) {
    const current = await readFile(path, 'utf8').catch(() => '')
    if (current !== expected) { stale = true; console.error(`Stale developer guide: ${file} (${target === skill ? 'skill' : 'developer'})`) }
  } else await writeFile(path, expected)
}
for (const file of files) {
  const expected = await readFile(join(source, file), 'utf8')
  await sync(developer, file, expected)
  await sync(skill, file, expected)
}
for (const file of localGuides) {
  const expected = await readFile(join(developer, file), 'utf8')
  await sync(skill, file, expected)
}
// A skill reference must be generated or registered, so anything else there is drift. Reported,
// never deleted: an unregistered file may be in-progress work, so removing it stays a human decision.
// docs/developer is not swept this way; it may hold hand-written guides that are not published.
const expectedNames = new Set([...files, ...localGuides])
for (const name of await readdir(skill).catch(() => [])) {
  if (!name.endsWith('.md') || expectedNames.has(name)) continue
  stale = true
  console.error(`Unregistered skill reference: ${name}`)
}
if (stale) process.exitCode = 1
else console.log(`${check ? 'Checked' : 'Synced'} ${files.length} developer guides + ${localGuides.length} local guide(s) (developer + skill)`)
