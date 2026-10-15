/** Binary compatibility transports may split UTF-8 at any byte; state belongs to one session. */
export function decodeTerminalData(session, data) {
  if (typeof data === 'string') {
    const prefix = session.outputDecoder?.decode() || ''
    session.outputDecoder = null
    return prefix + data
  }
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? data : Array.isArray(data) ? new Uint8Array(data) : null
  if (!bytes) return String(data)
  session.outputDecoder ||= new TextDecoder()
  return session.outputDecoder.decode(bytes, { stream: true })
}
