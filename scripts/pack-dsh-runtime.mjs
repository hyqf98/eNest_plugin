#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from './build-plugin.mjs'
import { DSH_DIR, DSH_VERSION, repositoryRoot } from './plugin-contract.mjs'

export async function packDshRuntime(directory, { outDir = join(repositoryRoot, 'dist') } = {}) {
  const runtime = join(directory, 'runtime')
  const manifest = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== DSH_VERSION) throw new Error('DSH runtime version does not match the release contract')
  const runtimeManifestPath = join(runtime, 'package.json')
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'))
  if ((runtimeManifest.platform && runtimeManifest.platform !== process.platform) || (runtimeManifest.arch && runtimeManifest.arch !== process.arch)) {
    throw new Error('DSH runtime was built for another platform')
  }
  await writeFile(runtimeManifestPath, `${JSON.stringify({ ...runtimeManifest, platform: process.platform, arch: process.arch }, null, 2)}\n`)
  await mkdir(outDir, { recursive: true })
  const name = `dsh-runtime-${DSH_VERSION}-${process.platform}-${process.arch}.tgz`
  const destination = resolve(outDir, name)
  const staging = `${destination}.partial`
  try {
    execFileSync('tar', ['-czhf', staging, '-C', runtime, './node_modules', './package.json'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const entries = execFileSync('tar', ['-tvzf', staging], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (entries.split(/\r?\n/).filter(Boolean).some((line) => !['-', 'd'].includes(line[0]))) {
      throw new Error('DSH runtime contains archive links; rebuild with build-plugin before publishing')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(staging)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    await rename(staging, destination)
    await writeFile(`${destination}.sha256`, `${sha256}  ${name}\n`)
    return { name, path: destination, sha256 }
  } finally {
    await rm(staging, { force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Native runtime assets are built explicitly; release plugin archives no longer embed them.
  const directory = await buildPlugin(DSH_DIR, { runtime: true })
  console.log(JSON.stringify(await packDshRuntime(directory)))
}
