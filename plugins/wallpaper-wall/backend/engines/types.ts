import type {
  DynamicSpec,
  EngineCapabilities,
  EngineDescriptor,
  EngineDetection,
  EngineDiagnostics,
  EngineInstallProgress,
  EngineInstallResult,
  EngineSession,
  EngineSettings,
  EngineStatus,
} from '@backend/contracts'

export interface EngineInstallContext {
  signal?: AbortSignal
  onProgress(progress: EngineInstallProgress): void
}

export interface EngineAdapter {
  readonly descriptor: EngineDescriptor
  capabilities(): EngineCapabilities
  detect(): Promise<EngineDetection>
  install?(context: EngineInstallContext): Promise<EngineInstallResult>
  uninstall?(): Promise<void>
  start(spec: DynamicSpec): Promise<EngineSession>
  stop(): Promise<void>
  status(): EngineStatus
  applySettings(settings: EngineSettings): Promise<void>
  diagnostics(): Promise<EngineDiagnostics>
  dispose?(): Promise<void>
}

export function supportedOnPlatform(descriptor: EngineDescriptor): boolean {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return descriptor.platforms.includes(platform)
}
