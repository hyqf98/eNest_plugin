/** Electron utility message port; no renderer or host runtime imports. */
export interface BackendMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
export const parentPort = (process as NodeJS.Process & { parentPort?: BackendMessagePort }).parentPort
