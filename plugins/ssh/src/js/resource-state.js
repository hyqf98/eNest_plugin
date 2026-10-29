// The workbench owns sampling; other layouts only consume its current-session snapshot.
let state = { sessionId: null, name: '', target: '', status: 'idle', sample: null, sampledAt: 0, loading: false, error: '' }
const listeners = new Set()

export const getResourceState = () => state

export function publishResourceState(patch) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

export function subscribeResourceState(listener) {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}
