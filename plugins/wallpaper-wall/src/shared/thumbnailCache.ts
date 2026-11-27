export class ThumbnailCache<Value extends { dataUrl: string | null }> {
  private readonly entries = new Map<string, Value>()
  private bytes = 0

  constructor(private readonly maxEntries: number, private readonly maxBytes = 16 * 1024 * 1024) {}

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (entry) { this.entries.delete(key); this.entries.set(key, entry) }
    return entry
  }

  delete(key: string): void {
    this.bytes -= this.entries.get(key)?.dataUrl?.length ?? 0
    this.entries.delete(key)
  }

  set(key: string, entry: Value): Value {
    this.delete(key)
    const size = entry.dataUrl?.length ?? 0
    if (size > this.maxBytes) return entry
    this.entries.set(key, entry)
    this.bytes += size
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.delete(oldest.value)
    }
    return entry
  }
}
