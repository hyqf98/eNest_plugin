import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const DSH_DIR = 'dsh'
export const DSH_VERSION = '0.2.0-rc.2'

export function assertRuntimeTarget(target = 'universal') {
  if (target !== 'universal' && target !== `${process.platform}-${process.arch}`) {
    throw new Error('DSH runtime must be built and packed on its target platform')
  }
}
