import { cp, mkdir, readdir, readFile, lstat, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { repositoryRoot, localFile } from './plugin-contract.mjs'
import { normalizeTarget, packageMatchesTarget, platformPackagePlan } from './distribution-target.mjs'
import { backendPackageFileExclusions, assertPackageFilesCanBeExcluded } from './backend-package-files.mjs'

const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i

export function lockedPackagePath(root, directory) {
  const marker = relative(root, directory).split(sep).join('/')
  if (!marker.startsWith('node_modules/') || marker.split('/').some(part => part === '..' || !part)) throw new Error('External backend dependency must come from locked node_modules')
  return marker
}

export function validateNativeArchive(archive) {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  if (names.some(file => !file.startsWith('package/') || file.split('/').includes('..') || /[\\\u0000-\u001f\u007f]/.test(file))) throw new Error('Unsafe native package archive path')
  // Check entry types before extraction: name-only listings cannot expose symlink/hardlink targets.
  const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n')
  if (entries.some(line => !/^[d-]/.test(line))) throw new Error('Unsafe native package archive entry type')
}

function packageAt(name, from) {
  if (!packageName.test(name)) throw new Error(`Invalid backend dependency ${name}`)
  const require = createRequire(join(from, 'package.json'))
  // Some npm packages deliberately share a name with a Node builtin (e.g. string_decoder).
  for (const directory of require.resolve.paths('__enest_package_lookup__') || []) {
    const candidate = join(directory, name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  throw new Error(`Backend dependency ${name} is not installed; run npm ci in the plugin repository`)
}

/** Copy only the package itself, preserving runtime src/data and licenses; dependencies are resolved separately. */
async function copyPackage(source, target, name, excludedFiles = new Set()) {
  assertPackageFilesCanBeExcluded(source, name, excludedFiles)
  await mkdir(target, { recursive: true })
  async function visit(dir, dest, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || /^(?:tests?|__tests__|examples?|coverage)$/.test(entry.name) || /\.(?:map|tsx?|mts|cts)$/.test(entry.name)) continue
      if (excludedFiles.has(rel)) continue
      const from = join(dir, entry.name), to = join(dest, entry.name)
      if ((await lstat(from)).isSymbolicLink()) throw new Error(`Backend package symlink: ${name}/${rel}`)
      if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await visit(from, to, rel + '/') }
      else if (entry.isFile()) await cp(from, to)
      else throw new Error(`Unsupported backend file ${name}/${rel}`)
    }
  }
  await visit(source, target)
}

export async function buildBackend(source, destination, { root = repositoryRoot, target: distributionTarget = 'universal' } = {}) {
  normalizeTarget(distributionTarget)
  root = realpathSync(root)
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
  if (!manifest.backend) return
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')), spec = pkg.enestBackend
  if (!spec || !Array.isArray(spec.dependencies) || !manifest.permissions?.includes('backend.node')) throw new Error('backend requires enestBackend build config and backend.node permission')
  const excludedFiles = backendPackageFileExclusions(spec)
  if (manifest.backend.entry !== 'backend/index.cjs') throw new Error('build backend output must be backend/index.cjs')
  const entry = localFile(source, spec.entry), target = join(destination, 'backend')
  await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true })
  for (const name of spec.dependencies) if (!pkg.dependencies?.[name]) throw new Error(`${pkg.name}: backend dependency ${name} must be declared directly`)
  await build({ entryPoints: [entry], outfile: join(target, 'index.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false,
    alias: { '@backend': join(source, 'backend') }, external: spec.dependencies, logLevel: 'warning', metafile: true,
    plugins: [{ name: 'forbid-host-imports', setup(builder) { builder.onResolve({ filter: /^(?:electron|@main\/|@preload\/|@renderer\/|@shared\/)/ }, args => ({ errors: [{ text: `Plugin backend cannot import host code: ${args.path}` }] })) } }]
  })
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const copied = new Map(), excluded = new Set(spec.optionalExcluded || [])
  async function dependency(name, from, optional = false) {
    if (optional && excluded.has(name)) return
    let directory
    try { directory = packageAt(name, from) } catch (error) { if (optional) return; throw error }
    if (copied.has(directory)) {
      if (!optional) delete copied.get(directory).optional
      return
    }
    const data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (!packageMatchesTarget(data, distributionTarget)) {
      if (optional) return
      throw new Error(`Required backend dependency ${name} is incompatible with ${distributionTarget}`)
    }
    // Preserve the lockfile's physical node_modules layout so duplicate versions resolve identically.
    const marker = lockedPackagePath(root, directory)
    if (data.name !== name || lock.packages?.[marker]?.version !== data.version) throw new Error(`Backend dependency does not match lockfile: ${name}`)
    copied.set(directory, { name, version: data.version, path: marker, ...(optional ? { optional: true } : {}) })
    await copyPackage(directory, join(target, marker), name, excludedFiles.get(name))
    const optionalDeps = data.optionalDependencies || {}
    for (const child of Object.keys(data.dependencies || {})) if (!(child in optionalDeps)) await dependency(child, directory)
    for (const child of Object.keys(optionalDeps)) await dependency(child, directory, true)
    for (const child of Object.keys(data.peerDependencies || {})) await dependency(child, directory, data.peerDependenciesMeta?.[child]?.optional === true)
  }
  for (const name of spec.dependencies) await dependency(name, source)

  // Universal remains the default; explicit targets contain only their locked native variant.
  const platformPlan = platformPackagePlan(source, { root, target: distributionTarget })
  const platformInventory = []
  for (const { name } of platformPlan.packages) {
    if (!packageName.test(name)) throw new Error('Invalid native package name')
    const matches = Object.entries(lock.packages || {}).filter(([key]) => key.endsWith(`node_modules/${name}`))
    if (matches.length !== 1) throw new Error(`Expected one locked native platform package: ${name}`)
    const [location, data] = matches[0]
    if (!data.resolved?.startsWith('https://registry.npmjs.org/') || !data.integrity?.startsWith('sha512-')) throw new Error(`Unverified native package ${name}`)
    const installed = join(root, location)
    if (lockedPackagePath(root, installed) !== location) throw new Error(`Invalid locked native package path: ${name}`)
    platformInventory.push({ name, version: data.version, path: location, integrity: data.integrity })
    if (existsSync(join(installed, 'package.json'))) {
      if ((await lstat(installed)).isSymbolicLink()) throw new Error(`Native package symlink: ${name}`)
      const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      if (installedPackage.name !== name || installedPackage.version !== data.version) throw new Error(`Native package identity mismatch: ${name}`)
      await copyPackage(installed, join(target, location), name, excludedFiles.get(name)); continue
    }
    const cache = join(root, 'dist/backend-cache', name.replaceAll('/', '-'), data.version)
    await mkdir(cache, { recursive: true })
    const archive = join(cache, 'package.tgz')
    if (!existsSync(archive)) {
      const result = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', data.resolved, '--ignore-scripts', '--json', '--pack-destination', cache], { cwd: root, encoding: 'utf8' }))
      await cp(join(cache, result[0].filename), archive)
    }
    const archiveBytes = await readFile(archive)
    if (`sha512-${createHash('sha512').update(archiveBytes).digest('base64')}` !== data.integrity) throw new Error(`Native package integrity mismatch: ${name}`)
    const unpack = join(cache, 'unpacked'); await rm(unpack, { recursive: true, force: true }); await mkdir(unpack)
    validateNativeArchive(archive)
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', unpack])
    const unpackedPackage = JSON.parse(await readFile(join(unpack, 'package/package.json'), 'utf8'))
    if (unpackedPackage.name !== name || unpackedPackage.version !== data.version) throw new Error('Native package identity mismatch')
    await copyPackage(join(unpack, 'package'), join(target, location), name, excludedFiles.get(name))
  }
  await writeFile(join(target, 'dependency-inventory.json'), JSON.stringify({ node: '>=24', target: distributionTarget, supportedTargets: platformPlan.supportedTargets, dependencies: [...copied.values()], platformPackages: platformPlan.packages.map(pkg => pkg.name), nativePackages: platformInventory }, null, 2) + '\n')
}
