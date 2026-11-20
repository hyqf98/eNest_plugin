import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * tvbox 构建钩子：把插件根 presets/ 下内置示例配置（保开箱可用的采集站配置
 * 与直播示例、drpy2 运行时脚本）作为后端私有 runtime/ 附件带入发布包。
 * 后端从 runtime/presets/ 读取，不经页面资源协议。
 */
export async function afterBuild({ source, directory }) {
  const presetsDir = join(source, 'presets')
  if (!existsSync(presetsDir)) return
  const target = join(directory, 'runtime', 'presets')
  await mkdir(target, { recursive: true })
  await cp(presetsDir, target, { recursive: true, dereference: true })
}

export async function validateDistribution({ directory }) {
  const runtimePresets = join(directory, 'runtime', 'presets')
  if (!existsSync(runtimePresets)) throw new Error('tvbox: runtime/presets is missing from distribution')
}
