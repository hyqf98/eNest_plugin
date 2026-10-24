export const WORKSPACE_ROUTES = Object.freeze(['catalog', 'detail'])

// Installed/all are local catalog filters, never host navigation targets.
export function normalizeWorkspaceRoute(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace route')
  if (input.page === 'catalog' && Object.keys(input).length === 1) return { page: 'catalog' }
  if (input.page === 'detail' && Object.keys(input).every(key => key === 'page' || key === 'pluginId') &&
    typeof input.pluginId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.pluginId)) {
    return { page: 'detail', pluginId: input.pluginId }
  }
  throw new Error('Invalid workspace route')
}
