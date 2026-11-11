import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const DSH_DIR = 'dsh'
// 仅作本地开发捆绑构建（build-plugin dsh --runtime）的默认版本；
// 正式运行时发布由 dsh-runtime-v<version> 标签驱动，见 .github/workflows/dsh-runtime.yml。
export const DSH_VERSION = '0.2.0-rc.2'
export const DSH_RUNTIME_TAG_PREFIX = 'dsh-runtime-v'

/** 发布版本以环境变量为准（CI 从标签解析注入），与插件端 safeRuntimeVersion 同规则校验。 */
export function resolveRuntimeVersion() {
  const override = process.env.DSH_RUNTIME_VERSION
  if (override === undefined || override === '') return DSH_VERSION
  if (override.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(override)) {
    throw new Error(`非法 DSH 运行时版本: ${override}`)
  }
  return override
}

export function assertRuntimeTarget(target = 'universal') {
  if (target !== 'universal' && target !== `${process.platform}-${process.arch}`) {
    throw new Error('DSH runtime must be built and packed on its target platform')
  }
}
