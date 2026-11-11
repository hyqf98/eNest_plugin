import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

const packageName = /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/i
const legalName = /^\.?(?:licen[cs]es?|copying|copyright|notices?)(?:[._-]|$)/i
const protectedName = name => name === 'package.json' || legalName.test(name)

/**
 * Exact package-relative exclusions for any package in the plugin's locked backend graph.
 * 形态在这里校验；该包是否真的在锁定依赖图中，由构建期按解析结果复核（见 build-backend）。
 */
export function backendPackageFileExclusions(spec) {
  const result = new Map()
  if (spec.packageFilesExcluded === undefined) return result
  const config = spec.packageFilesExcluded
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('enestBackend.packageFilesExcluded must be an object')
  for (const [name, paths] of Object.entries(config)) {
    if (!packageName.test(name)) throw new Error(`Invalid backend package exclusion package name: ${name}`)
    if (!Array.isArray(paths) || paths.length === 0) throw new Error(`packageFilesExcluded.${name} must be a non-empty path array`)
    const unique = new Set()
    for (const path of paths) {
      if (typeof path !== 'string' || !path || path.trim() !== path || /[\\:%?*\[\]{}<>|\u0000-\u001f\u007f]/.test(path)
        || path.split('/').some(part => !part || part.startsWith('.') || part === 'node_modules')) throw new Error(`Invalid exact backend package exclusion: ${name}/${path}`)
      if (path.split('/').some(protectedName)) throw new Error(`Cannot exclude backend package metadata or licenses: ${name}/${path}`)
      if (unique.has(path)) throw new Error(`Duplicate backend package exclusion: ${name}/${path}`)
      unique.add(path)
    }
    result.set(name, unique)
  }
  return result
}

/**
 * Declared runtime-unused dependencies, scoped to the plugin's locked dependency graph.
 * 语义：作者声明该依赖在运行时不会被 require，构建时不复制它的文件及其子树。
 * 只做形态校验；可达性与真实引用检查在构建时对锁文件依赖图执行。
 */
export function backendRuntimeExclusions(spec) {
  const result = new Set()
  if (spec.runtimeExcluded === undefined) return result
  const config = spec.runtimeExcluded
  if (!Array.isArray(config)) throw new Error('enestBackend.runtimeExcluded must be an array')
  const optional = new Set(Array.isArray(spec.optionalExcluded) ? spec.optionalExcluded : [])
  const platform = new Set(Array.isArray(spec.platformPackages) ? spec.platformPackages : [])
  for (const name of config) {
    if (typeof name !== 'string' || !packageName.test(name)) throw new Error(`Invalid backend runtime exclusion: ${name}`)
    if (result.has(name)) throw new Error(`Duplicate backend runtime exclusion: ${name}`)
    if (optional.has(name)) throw new Error(`Backend runtime exclusion conflicts with optionalExcluded: ${name}`)
    if (platform.has(name)) throw new Error(`Backend runtime exclusion conflicts with platformPackages: ${name}`)
    result.add(name)
  }
  return result
}

function stringValues(value) {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues)
  return []
}

function protectedPackagePaths(pkg) {
  const normalize = path => posix.normalize(path.replaceAll('\\', '/')).replace(/\/+$/, '')
  const entries = stringValues([pkg.main || ['index.js', 'index.json', 'index.node'], pkg.exports, pkg.bin, pkg.module, pkg.browser])
    .map(normalize)
  // Extensionless CommonJS entries may resolve to a file or a directory index.
  entries.push(...entries.filter(path => !path.includes('*')).flatMap(path => ['.js', '.json', '.node'].map(extension => path + extension)))
  for (const license of stringValues([pkg.license, pkg.licenses])) {
    const file = /^SEE LICEN[CS]E IN (.+)$/i.exec(license)?.[1]
    if (file) entries.push(normalize(file))
  }
  return entries
}

function overlapsEntry(path, entry) {
  if (entry === '.' || entry === '') return true
  const wildcard = entry.indexOf('*')
  if (wildcard >= 0) {
    const prefix = entry.slice(0, wildcard)
    return path.startsWith(prefix) || prefix === path || prefix.startsWith(`${path}/`)
  }
  return path === entry || entry.startsWith(`${path}/`) || path.startsWith(`${entry}/`)
}

/** Check the installed package before filtering; never delete paths from the source. */
export function assertPackageFilesCanBeExcluded(directory, name, paths = new Set()) {
  if (!paths.size) return
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const entries = protectedPackagePaths(pkg)
  const inspect = (path, stat) => {
    if (path.split('/').some(protectedName) || entries.some(entry => overlapsEntry(path, entry))) throw new Error(`Cannot exclude backend package entry, metadata or licenses: ${name}/${path}`)
    // The entire subtree is omitted, so links here are opaque leaves, never followed.
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) for (const child of readdirSync(join(directory, path))) {
      const childPath = `${path}/${child}`
      inspect(childPath, lstatSync(join(directory, childPath)))
    }
    else if (!stat.isFile()) throw new Error(`Unsupported backend file ${name}/${path}`)
  }
  for (const path of paths) {
    if (entries.some(entry => overlapsEntry(path, entry))) throw new Error(`Cannot exclude backend package entry: ${name}/${path}`)
    let current = directory, stat
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      try { stat = lstatSync(current) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        stat = undefined
        break // Optional build outputs need not exist on every development machine.
      }
      if (stat.isSymbolicLink() && index < parts.length - 1) throw new Error(`Backend package exclusion traverses a symlink: ${name}/${path}`)
    }
    if (stat) inspect(path, stat)
  }
}
