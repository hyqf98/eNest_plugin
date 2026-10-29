/**
 * PromptEditor — 用 @ 引用上游文本/图片的提示词编辑器（contenteditable）。
 *
 * 存储值仍是标准字符串：文本原样 + {{#nodeId.port#}} 令牌（与执行引擎变量引用同源）。
 * 编辑态把令牌渲染成内联 chip：图片端口 → 缩略图（悬停放大），文本端口 → 名称标记。
 * 输入 @ 呼出上游变量选择器，选中即在光标处插入令牌。
 * React Flow 对 contenteditable 元素会跳过拖拽/快捷键，节点不会因此被拖动。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { getNodeDef } from '../js/nodeRegistry.mjs'
import { listUpstreamVariables, varSelector } from '../js/variables.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'
import { VariablePicker } from './VariablePicker.jsx'

const TOKEN_RE = /\{\{#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)#\}\}/g

/** 把值字符串切成交替的 {text} / {ref} 段 */
function splitValue(value) {
  const text = String(value ?? '')
  const parts = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) })
    parts.push({ type: 'ref', nodeId: m[1], portKey: m[2], raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

/** 令牌对应端口的展示信息 */
function describeRef(nodeId, portKey, nodes, getOutputs) {
  const node = nodes.find(n => n.id === nodeId)
  const def = node ? getNodeDef(node.data?.type) : null
  const port = def?.outputs?.find(p => p.key === portKey)
  if (!def || !port) return { kind: null, label: nodeId.slice(0, 6), invalid: true }
  const value = getOutputs?.(nodeId)?.[portKey]
  const imageAssetId = port.kind === 'image' ? (Array.isArray(value) ? value[0]?.assetId : value?.assetId) : null
  return {
    kind: port.kind,
    label: `${def.title}›${port.label ?? port.key}`,
    imageAssetId: imageAssetId ?? null,
    invalid: false
  }
}

/**
 * @param value 受控字符串（含 {{#id.port#}} 令牌）
 * @param onChange (next) 文本改动回调
 * @param nodes/edges/getOutputs 供变量选择器与令牌解析
 * @param placeholder rows
 */
export const PromptEditor = forwardRef(function PromptEditor(
  { value, onChange, nodes, edges, nodeId, getOutputs, placeholder = '', className = '' }, ref) {
  const editableRef = useRef(null)
  const [picker, setPicker] = useState(null)   // { anchor }
  const savedRangeRef = useRef(null)           // @ 触发时的光标 Range（弹层抢焦点后恢复插入点）
  const composingRef = useRef(false)

  const upstreamGroups = () => listUpstreamVariables({ nodeId, nodes, edges, getOutputs })
    .map(g => ({ nodeId: g.nodeId, title: g.title, glyph: g.glyph, vars: g.vars }))

  // 序列化：DOM → 字符串
  const serialize = useCallback(() => {
    const root = editableRef.current
    if (!root) return ''
    let out = ''
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') out += '\n'
        else if (child.dataset?.token) out += child.dataset.token
        else out += child.innerText ?? child.textContent ?? ''
      }
    }
    return out
  }, [])

  const emit = useCallback(() => { onChange?.(serialize()) }, [onChange, serialize])

  // 外部值变化时重建（仅当与当前 DOM 序列化不同，避免打断输入）
  const setFromValue = useCallback((next) => {
    const root = editableRef.current
    if (!root) return
    if (serialize() === String(next ?? '')) return
    root.innerHTML = ''
    for (const part of splitValue(next)) {
      if (part.type === 'text') root.appendChild(document.createTextNode(part.text))
      else root.appendChild(makeChipNode(part, nodes, getOutputs))
    }
  }, [serialize, nodes, getOutputs])

  useEffect(() => { setFromValue(value) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  // 令牌失效或上游产物更新后，chip 需要重绘：值不变时也强制按最新值重建
  useEffect(() => { setFromValue(value) }, [nodes, getOutputs]) // eslint-disable-line react-hooks/exhaustive-deps

  function makeChipNode(part, nodesArg, getOutputsArg) {
    const span = document.createElement('span')
    const info = describeRef(part.nodeId, part.portKey, nodesArg, getOutputsArg)
    span.contentEditable = 'false'
    span.dataset.chip = '1'
    span.dataset.token = varSelector(part.nodeId, part.portKey)
    if (info.kind === 'image' && info.imageAssetId) {
      span.className = 'ac-refchip ac-ref-image' + (info.invalid ? ' ac-ref-invalid' : '')
      const img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      img.dataset.assetId = info.imageAssetId
      assetPreviewUrl(info.imageAssetId).then(u => { if (u) { img.src = u; span.appendChild(img) } }).catch(() => {})
      span.appendChild(img)
    } else {
      span.className = `ac-refchip ac-ref-${info.kind ?? 'text'}` + (info.invalid ? ' ac-ref-invalid' : '')
      span.textContent = `${info.kind === 'image' ? '图' : info.kind === 'json' ? '物' : '文'} ${info.label}`
    }
    span.addEventListener('mouseenter', e => {
      const imgEl = e.currentTarget.querySelector('img[data-asset-id]')
      if (!imgEl?.src) return
      const r = imgEl.getBoundingClientRect()
      let tip = document.getElementById('ac-ref-zoom')
      if (!tip) { tip = document.createElement('div'); tip.id = 'ac-ref-zoom'; tip.className = 'ac-ref-zoom'; document.body.appendChild(tip) }
      tip.innerHTML = ''
      const big = document.createElement('img'); big.src = imgEl.src
      tip.appendChild(big)
      tip.style.left = `${Math.min(r.right + 8, window.innerWidth - 340)}px`
      tip.style.top = `${Math.max(8, r.top - 50)}px`
      tip.hidden = false
    })
    span.addEventListener('mouseleave', () => { const t = document.getElementById('ac-ref-zoom'); if (t) t.hidden = true })
    return span
  }

  // 在光标处插入 chip（弹层可能已抢走焦点：先恢复 @ 触发时保存的 Range）
  const insertChip = useCallback((varItem) => {
    const root = editableRef.current
    if (!root) return
    root.focus()
    const sel = window.getSelection()
    if (savedRangeRef.current && root.contains(savedRangeRef.current.startContainer)) {
      sel?.removeAllRanges()
      sel?.addRange(savedRangeRef.current)
    }
    // 移除触发用的 @ 与其后正在输入的查询串
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0)
      const textNode = range.startContainer
      if (textNode.nodeType === Node.TEXT_NODE) {
        const upto = textNode.nodeValue.slice(0, range.startOffset)
        const atPos = upto.lastIndexOf('@')
        if (atPos >= 0) textNode.nodeValue = textNode.nodeValue.slice(0, atPos) + textNode.nodeValue.slice(range.startOffset)
      }
    }
    const rng = sel?.rangeCount ? sel.getRangeAt(0) : null
    const chip = makeChipNode({ nodeId: varItem.nodeId, portKey: varItem.portKey }, nodes, getOutputs)
    if (rng) { rng.deleteContents(); rng.insertNode(chip) }
    else root.appendChild(chip)
    // 光标移到 chip 后
    const after = document.createRange()
    after.setStartAfter(chip); after.collapse(true)
    sel?.removeAllRanges(); sel?.addRange(after)
    savedRangeRef.current = null
    emit()
  }, [emit, nodes, getOutputs])

  const handleInput = useCallback(() => {
    if (composingRef.current) return
    // 检测光标前是否有 @ + 查询
    const sel = window.getSelection()
    const node = sel?.anchorNode
    if (node?.nodeType === Node.TEXT_NODE) {
      const upto = (node.nodeValue || '').slice(0, sel.anchorOffset)
      const at = upto.lastIndexOf('@')
      if (at >= 0 && !/\s/.test(upto.slice(at + 1))) {
        // 保存光标：弹层搜索框会抢焦点，插入时凭此恢复
        savedRangeRef.current = sel.getRangeAt(0).cloneRange()
        const rect = caretRect()
        setPicker({ anchor: rect ? { x: rect.left, y: rect.bottom + 6 } : clientCenter() })
        return
      }
    }
    setPicker(null)
    emit()
  }, [emit])

  function caretRect() {
    const sel = window.getSelection()
    if (!sel?.rangeCount) return null
    const r = sel.getRangeAt(0).getBoundingClientRect()
    if (r.width === 0 && r.x === 0 && r.y === 0) {
      const probe = document.createRange()
      probe.setStart(sel.focusNode, Math.max(0, sel.focusOffset - 1))
      const rr = probe.getBoundingClientRect()
      if (rr.width || rr.x || rr.y) return rr
      return null
    }
    return r
  }
  function clientCenter() {
    const root = editableRef.current.getBoundingClientRect()
    return { x: root.left + 20, y: root.top + 20 }
  }

  useImperativeHandle(ref, () => ({ focus: () => editableRef.current?.focus() }), [])

  return <>
    <div
      ref={editableRef}
      className={`ac-input ac-textarea ac-prompt nodrag ${className}`}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      role="textbox"
      onInput={handleInput}
      onBlur={emit}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => { composingRef.current = false; handleInput() }}
    />
    {picker && (
      <VariablePicker
        anchor={picker.anchor}
        groups={upstreamGroups()}
        emptyHint="没有可引用的上游变量（上游节点需先运行出结果）"
        onInsert={varItem => { insertChip({ nodeId: varItem.nodeId, portKey: varItem.portKey }); setPicker(null) }}
        onClose={() => setPicker(null)}
      />
    )}
  </>
})
