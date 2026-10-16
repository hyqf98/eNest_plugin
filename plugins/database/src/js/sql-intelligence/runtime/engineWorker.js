import { buildCompletion, signatureHelp } from '@db/sql-intelligence/completionEngine.js'

self.onmessage = ({ data }) => {
  try {
    const result = data.method === 'signature' ? signatureHelp(data.request, data.options) : buildCompletion(data.request, data.options)
    self.postMessage({ id: data.id, result })
  } catch (error) { self.postMessage({ id: data.id, error: String(error.message || error) }) }
}
