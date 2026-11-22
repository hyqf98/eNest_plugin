import type { EngineDescriptor } from '@backend/contracts'

export const engineDescriptors: EngineDescriptor[] = [
  {
    id: 'builtin-light',
    name: '内置轻量引擎',
    version: '0.0.1',
    description: '随插件分发的视频/GIF/Web 渲染层，只使用系统 WebView；无需安装外部应用。',
    homepage: 'https://github.com/hyqf98/eNest_plugin',
    license: '随 eNest 插件分发',
    distribution: 'bundled',
    platforms: ['win32', 'darwin', 'linux'],
    mediaTypes: ['image', 'video', 'gif', 'web'],
    default: true,
    installHint: '内置引擎随插件包提供，无需安装。',
  },
]
