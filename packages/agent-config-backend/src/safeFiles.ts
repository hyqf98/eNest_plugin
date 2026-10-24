import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function inside(root: string, path: string): boolean {
  const delta = relative(root, path)
  return !delta || delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
}

function existingParent(path: string): string {
  let parent = dirname(path)
  while (!fs.existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw new Error('No existing filesystem anchor')
    parent = next
  }
  return parent
}

/** Node backends are trusted, not sandboxed; these checks still protect selected application paths. */
export function createSafeFiles(homePath: string, backupPath: string, extraRoots: string[] = []) {
  const roots = [
    { root: homePath, anchor: homePath },
    { root: backupPath, anchor: existingParent(backupPath) },
    ...extraRoots.map(root => ({ root, anchor: existingParent(root) }))
  ].map(({ root, anchor }) => {
    if (!isAbsolute(root) || !isAbsolute(anchor)) throw new Error('Expected absolute backend paths')
    const base = fs.realpathSync(anchor)
    return { root: resolve(root), base, target: resolve(base, relative(anchor, root)) }
  })

  function checked(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Expected an absolute application path')
    const path = resolve(value)
    const scope = roots.find(item => inside(item.root, path) || inside(item.target, path))
    if (!scope) throw new Error('Path is outside application roots')
    if (fs.realpathSync(scope.base) !== scope.base || fs.lstatSync(scope.base).isSymbolicLink()) throw new Error('Application filesystem anchor changed')
    const target = inside(scope.root, path) ? resolve(scope.target, relative(scope.root, path)) : path
    let cursor = scope.base
    for (const part of relative(scope.base, target).split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      let info: fs.Stats
      try { info = fs.lstatSync(cursor) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in application paths')
    }
    return target
  }

  function assertTree(path: string, budget = { remaining: 10000 }): void {
    if (--budget.remaining < 0) throw new Error('Directory operation exceeds file budget')
    const target = checked(path), info = fs.lstatSync(target)
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in application paths')
    if (info.isDirectory()) for (const name of fs.readdirSync(target)) assertTree(join(target, name), budget)
    else if (!info.isFile()) throw new Error('Expected a regular application file')
  }

  const existsSync = ((path: fs.PathLike) => fs.existsSync(checked(path))) as typeof fs.existsSync
  const statSync = ((path: fs.PathLike) => fs.lstatSync(checked(path))) as typeof fs.statSync
  const readdirSync = ((path: fs.PathLike, options?: unknown) => Reflect.apply(fs.readdirSync, fs, [checked(path), options])) as typeof fs.readdirSync
  const mkdirSync = ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    const target = checked(path)
    const result = fs.mkdirSync(target, options)
    checked(path)
    return result
  }) as typeof fs.mkdirSync
  const openSync = ((path: fs.PathLike, flags: fs.OpenMode) => {
    if (flags !== 'r') throw new Error('Only bounded read handles are supported')
    const fd = fs.openSync(checked(path), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error('Expected a regular application file') }
    return fd
  }) as typeof fs.openSync
  const readFileSync = ((path: fs.PathOrFileDescriptor, options?: BufferEncoding | { encoding?: BufferEncoding | null }) => {
    if (typeof path !== 'string') throw new Error('Expected an application file path')
    const fd = openSync(path, 'r')
    try {
      if (fs.fstatSync(fd).size > 8 * 1024 * 1024) throw new Error('Application file exceeds 8 MiB')
      return fs.readFileSync(fd, options as BufferEncoding)
    } finally { fs.closeSync(fd) }
  }) as typeof fs.readFileSync
  const writeFileSync = ((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    const target = checked(path), directory = checked(dirname(target))
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error('Expected a regular application file')
    const temporary = join(directory, `.enest-write-${randomUUID()}`)
    let fd: number | undefined
    try {
      const mode = fs.existsSync(target) ? fs.lstatSync(target).mode & 0o777 : 0o600
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), mode)
      fs.writeFileSync(fd, data, options)
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
      checked(target)
      fs.renameSync(temporary, target)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      fs.rmSync(temporary, { force: true })
    }
  }) as typeof fs.writeFileSync
  const rmSync = ((path: fs.PathLike, options?: fs.RmOptions) => {
    const target = checked(path)
    if (!fs.existsSync(target) && options?.force) return
    assertTree(target)
    fs.rmSync(target, options)
  }) as typeof fs.rmSync
  return { checked, assertTree, existsSync, statSync, readdirSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync }
}
