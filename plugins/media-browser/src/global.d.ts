import type { EnestPluginApi } from '@enest/plugin-sdk'

interface AppearanceLayoutOptions {
  plugin?: string
  family?: string
  scope?: string
  regions?: Record<string, string>
}

type MenuSource = Element | { currentTarget?: Element; target?: EventTarget | null; clientX?: number; clientY?: number }
type MenuItem = [key: string, label: string, options?: { danger?: boolean; disabled?: boolean; hint?: string }] | { sep: true }

interface PluginKitBridge {
  useAppearanceLayout(options: AppearanceLayoutOptions): unknown
  /** 右键/锚点菜单：Esc 与点击外部关闭，选择后回调 key */
  openMenu(source: MenuSource, items: MenuItem[], onPick?: (key: string) => void, options?: { align?: string; ariaLabel?: string }): unknown
}

declare global {
  interface Window {
    enest?: EnestPluginApi
    zapi?: EnestPluginApi
    PluginKit?: PluginKitBridge
  }
}

export {}
