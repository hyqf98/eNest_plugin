import { createDialog } from '@enest/plugin-kit/workbench'
import { clipboardWrite } from './api.js'

export function structuredValue(value) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) { try { return JSON.parse(value, (_key, item, context) => typeof item === 'number' && !Number.isSafeInteger(item) && Number.isInteger(item) && context?.source ? { $numberLong: context.source } : item) } catch { /* plain cell */ } }
  return null
}

/** Lazy child rendering keeps large documents navigable without expanding the full tree. */
export function openValueInspector(value, title = '单元格详情') {
  const parsed = structuredValue(value), display = parsed ?? value
  const source = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
  const modal = createDialog({ title, className: 'wb-document-inspector', content: '<div class="wb-document-actions"><button class="btn" data-tree>树形</button><button class="btn" data-source>原始内容</button><span class="spacer"></span><button class="btn" data-copy>复制内容</button></div><div class="wb-document-tree"></div><pre class="wb-document-source" hidden></pre>' })
  const root = modal.body.querySelector('.wb-document-tree'), raw = modal.body.querySelector('.wb-document-source'); raw.textContent = source ?? 'NULL'
  const append = (parent, key, item, depth = 0) => {
    const complex = item !== null && typeof item === 'object', node = document.createElement(complex ? 'details' : 'div'); node.className = 'wb-json-node'
    const label = document.createElement(complex ? 'summary' : 'span'), name = document.createElement('span'); name.className = 'wb-json-key'; name.textContent = key; label.append(name)
    const type = document.createElement('small'); type.textContent = item === null ? 'null' : Array.isArray(item) ? `array · ${item.length}` : complex ? `object · ${Object.keys(item).length}` : typeof item; label.append(type)
    if (!complex) { const scalar = document.createElement('span'); scalar.className = `wb-json-value is-${item === null ? 'null' : typeof item}`; scalar.textContent = item === null ? 'null' : String(item); label.append(scalar) }
    node.append(label); parent.append(node)
    if (complex) {
      let loaded = false
      node.addEventListener('toggle', () => {
        if (!node.open || loaded) return; loaded = true
        const children = document.createElement('div'); children.className = 'wb-json-children'; node.append(children)
        const entries = Object.entries(item); let offset = 0
        const more = document.createElement('button'); more.className = 'btn'; more.textContent = '继续加载 100 项'
        const batch = () => { more.remove(); for (const [childKey, child] of entries.slice(offset, offset + 100)) append(children, childKey, child, depth + 1); offset += 100; if (offset < entries.length) children.append(more) }
        more.onclick = batch; batch()
      })
      if (depth === 0) node.open = true
    }
  }
  append(root, 'root', display)
  modal.body.querySelector('[data-tree]').onclick = () => { root.hidden = false; raw.hidden = true }
  modal.body.querySelector('[data-source]').onclick = () => { root.hidden = true; raw.hidden = false }
  modal.body.querySelector('[data-copy]').onclick = async (event) => { await clipboardWrite(source ?? 'NULL'); event.target.textContent = '已复制' }
  return modal
}
