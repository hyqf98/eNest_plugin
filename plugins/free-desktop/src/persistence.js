import { readLayout } from './model.js'

const key = 'freeDesktop.layout.v1'
const regionKey = id => `${key}.region.${id}`

export function workspaceStore(storage) {
  let partitioned = false
  return {
    async read() {
      const saved = await storage.get(key)
      if (saved?.format !== 'regions') return readLayout(saved)
      const ids = saved.regions
      if (!Array.isArray(ids) || ids.length > 48 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !/^[-\w]{1,96}$/.test(id))) throw Error('区域索引损坏，未修改已有布局')
      const blocks = []
      for (let index = 0; index < ids.length; index += 6) {
        const batch = ids.slice(index, index + 6)
        const rows = await Promise.all(batch.map(id => storage.get(regionKey(id))))
        if (rows.some((row, position) => row?.id !== batch[position])) throw Error('区域记录缺失，未修改已有布局')
        blocks.push(...rows)
      }
      const layout = readLayout({ ...saved, blocks })
      partitioned = true
      return layout
    },
    async commit(previous, next) {
      const { blocks, ...header } = next
      const ids = new Set(blocks.map(block => block.id))
      const old = new Map(previous.blocks.map(block => [block.id, block]))
      const operations = [{ op: 'set', key, value: { ...header, format: 'regions', regions: [...ids] } }]
      for (const block of blocks) {
        if (!partitioned || JSON.stringify(old.get(block.id)) !== JSON.stringify(block))
          operations.push({ op: 'set', key: regionKey(block.id), value: block })
      }
      if (partitioned) for (const id of old.keys()) if (!ids.has(id)) operations.push({ op: 'remove', key: regionKey(id) })
      await storage.commit(operations)
      partitioned = true
    },
  }
}
