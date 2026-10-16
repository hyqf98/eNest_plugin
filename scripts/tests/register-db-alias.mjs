import { registerHooks } from 'node:module'

// Match the plugin's Vite/jsconfig alias when pure engine tests run directly in Node.
const root = new URL('../../plugins/database/src/js/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('@db/') ? new URL(specifier.slice(4), root).href : specifier, context)
  }
})
