import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { repositoryRoot } from './plugin-contract.mjs'

export const DISTRIBUTION_TARGET_FILE = 'assets/enest-distribution.json'
export const BACKEND_INVENTORY_FILE = 'backend/dependency-inventory.json'
export const PLATFORM_TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])

export function normalizeTarget(value = 'universal') {
  if (value !== 'universal' && !PLATFORM_TARGETS.includes(value)) throw new Error(`Unsupported plugin distribution target: ${value}`)
  return value
}

function matches(values, value) {
  if (!Array.isArray(values) || !values.length) return true
  if (values.includes(`!${value}`)) return false
  const allowed = values.filter(item => !item.startsWith('!'))
  return !allowed.length || allowed.includes(value) || allowed.includes('any')
}

export function packageMatchesTarget(pkg, target) {
  normalizeTarget(target)
  if (target === 'universal') return true
  const [platform, arch] = target.split('-')
  // The existing Linux release is glibc; a musl build must get a distinct future target.
  return matches(pkg.os, platform) && matches(pkg.cpu, arch) && (platform !== 'linux' || matches(pkg.libc, 'glibc'))
}

export function platformPackagePlan(source, { root = repositoryRoot, target = 'universal' } = {}) {
  normalizeTarget(target)
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const names = pkg.enestBackend?.platformPackages || []
  if (!names.length) return { packages: [], supportedTargets: [] }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const packages = names.map(name => {
    const matches = Object.entries(lock.packages || {}).filter(([key]) => key.endsWith(`node_modules/${name}`))
    if (matches.length !== 1) throw new Error(`Expected one locked native platform package: ${name}`)
    const [path, data] = matches[0]
    const targets = PLATFORM_TARGETS.filter(candidate => name.endsWith(`-${candidate}`) && packageMatchesTarget(data, candidate))
    if (targets.length !== 1) throw new Error(`Native package has no supported unambiguous target: ${name}`)
    return { name, path, data, target: targets[0] }
  })
  const supportedTargets = PLATFORM_TARGETS.filter(candidate => packages.some(pkg => pkg.target === candidate))
  if (target !== 'universal' && !supportedTargets.includes(target)) throw new Error(`${pkg.name}: native dependencies do not support ${target}`)
  return { packages: packages.filter(pkg => target === 'universal' || pkg.target === target), supportedTargets }
}

export function distributionDirectory(source, target = 'universal', root = repositoryRoot) {
  normalizeTarget(target)
  return target === 'universal' ? join(source, 'dist') : join(root, 'dist/platform-builds', target, basename(source))
}

export function resolveDistributionTarget(marker, inventory) {
  if (marker && marker.schemaVersion !== 1) throw new Error('Unsupported distribution target metadata version')
  if (marker && typeof marker.target !== 'string') throw new Error('Distribution target metadata must declare a target')
  const marked = marker ? normalizeTarget(marker.target) : undefined
  const backend = inventory?.target === undefined ? undefined : normalizeTarget(inventory.target)
  if (marked && backend && marked !== backend) throw new Error('Distribution and backend targets disagree')
  const target = marked ?? backend ?? 'universal'
  const natives = inventory?.nativePackages || []
  if (target !== 'universal' && natives.length) {
    if (!inventory.supportedTargets?.includes(target) || natives.some(pkg => typeof pkg.name !== 'string' || !pkg.name.endsWith(`-${target}`))) {
      throw new Error(`Native dependency inventory is incompatible with ${target}`)
    }
  }
  if (target === 'universal' && inventory?.supportedTargets) {
    for (const supported of inventory.supportedTargets) {
      normalizeTarget(supported)
      if (!natives.some(pkg => pkg.name.endsWith(`-${supported}`))) throw new Error(`Universal inventory is missing ${supported}`)
    }
  }
  return target
}

export async function readDistributionTarget(directory) {
  const read = async file => existsSync(join(directory, file)) ? JSON.parse(await readFile(join(directory, file), 'utf8')) : undefined
  return resolveDistributionTarget(await read(DISTRIBUTION_TARGET_FILE), await read(BACKEND_INVENTORY_FILE))
}

export async function writeDistributionTarget(directory, target) {
  normalizeTarget(target)
  const file = join(directory, DISTRIBUTION_TARGET_FILE)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ schemaVersion: 1, target }, null, 2) + '\n')
}

/** Derive release variants without rebuilding frontend bundles or changing the portable dist. */
export async function projectPlatformDistribution(directory, destination, source, { root = repositoryRoot, target } = {}) {
  normalizeTarget(target)
  if (target === 'universal') throw new Error('A platform projection requires an explicit target')
  const contains = (parent, child) => {
    const path = relative(resolve(parent), resolve(child))
    return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  }
  if (contains(directory, destination) || contains(destination, directory)) throw new Error('Platform projection cannot overlap the portable distribution')
  if (await readDistributionTarget(directory) !== 'universal') throw new Error('Platform variants require a universal source distribution')
  const plan = platformPackagePlan(source, { root, target })
  const all = platformPackagePlan(source, { root }).packages
  const selected = new Set(plan.packages.map(pkg => pkg.name))
  const excluded = all.filter(pkg => !selected.has(pkg.name)).map(pkg => `backend/${pkg.path}`)
  const inventoryFile = join(directory, BACKEND_INVENTORY_FILE)
  const inventory = existsSync(inventoryFile) ? JSON.parse(await readFile(inventoryFile, 'utf8')) : null
  if (all.length && !inventory) throw new Error('Native distribution is missing its dependency inventory')
  for (const pkg of all) {
    if (!existsSync(join(directory, 'backend', pkg.path, 'package.json'))) throw new Error(`Universal distribution is missing ${pkg.name}`)
  }
  for (const dependency of inventory?.dependencies || []) {
    const file = join(directory, 'backend', dependency.path, 'package.json')
    const pkg = JSON.parse(await readFile(file, 'utf8'))
    if (!packageMatchesTarget(pkg, target) && !all.some(native => native.path === dependency.path)) {
      if (!dependency.optional) throw new Error(`Required dependency ${dependency.name} is incompatible with ${target}`)
      excluded.push(`backend/${dependency.path}`)
    }
  }
  const omitted = path => excluded.some(prefix => path === prefix || path.startsWith(prefix + '/'))
  await rm(destination, { recursive: true, force: true })
  await cp(directory, destination, { recursive: true, filter: file => !omitted(relative(directory, file).split(sep).join('/')) })
  if (inventory) {
    const next = { ...inventory, target, supportedTargets: plan.supportedTargets,
      dependencies: inventory.dependencies.filter(pkg => !omitted(`backend/${pkg.path}`)),
      platformPackages: plan.packages.map(pkg => pkg.name),
      nativePackages: inventory.nativePackages.filter(pkg => selected.has(pkg.name)) }
    if (next.nativePackages.length !== plan.packages.length) throw new Error('Native dependency inventory is incomplete')
    await writeFile(join(destination, BACKEND_INVENTORY_FILE), JSON.stringify(next, null, 2) + '\n')
  }
  await writeDistributionTarget(destination, target)
  return destination
}
