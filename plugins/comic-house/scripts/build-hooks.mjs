import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * comic-house 构建钩子：把插件根 sources/ 下经可用性验证的漫画源脚本
 * 作为后端私有 runtime/ 附件带入发布包（runtime/sources/）。
 * 源脚本由后端在用户点击「一键安装推荐源」时读取并安装，不经页面资源协议。
 */
export async function afterBuild({ source, directory }) {
  const sourcesDir = join(source, 'sources')
  if (!existsSync(sourcesDir)) return
  const files = (await readdir(sourcesDir)).filter(file => file.endsWith('.js'))
  if (!files.length) return
  const target = join(directory, 'runtime', 'sources')
  await mkdir(target, { recursive: true })
  await cp(sourcesDir, target, { recursive: true, dereference: true })
}

export async function validateDistribution({ directory }) {
  // 声明了内置源的包必须真的带上；缺目录属于构建事故而非可选场景
  const runtimeSources = join(directory, 'runtime', 'sources')
  if (!existsSync(runtimeSources)) throw new Error('comic-house: runtime/sources is missing from distribution')
}
