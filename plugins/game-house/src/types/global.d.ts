import type { EnestPluginApi } from '@enest/plugin-sdk'

interface AppearanceLayoutOptions {
  plugin?: string
  family?: string
  scope?: string
  regions?: Record<string, string>
}

interface PluginKitBridge {
  useAppearanceLayout(options: AppearanceLayoutOptions): unknown
}

declare global {
  interface Window {
    enest?: EnestPluginApi
    zapi?: EnestPluginApi
    PluginKit?: PluginKitBridge
  }
}

export {}
