/**
 * 多选模型：普通点击、Ctrl/Cmd 追加、Shift 范围选择。
 * 纯函数，左右两个面板共用。
 */

export interface SelectionInput {
  /** 当前选中项（有序，按加入顺序） */
  selected: string[]
  /** 上次普通点击（锚点）所在的条目；范围选择以它为一端 */
  anchor: string | null
  /** 本次点击的条目 */
  id: string
  shift: boolean
  toggle: boolean
  /** 当前可见条目的顺序，范围选择按它取区间 */
  order: string[]
}

export interface SelectionResult {
  selected: string[]
  anchor: string | null
}

export function applySelection(input: SelectionInput): SelectionResult {
  const { selected, anchor, id, shift, toggle, order } = input
  if (shift && anchor && order.includes(anchor) && order.includes(id)) {
    // 范围选择：以锚点和当前点击为两端，替换掉原有选择
    const from = order.indexOf(anchor)
    const to = order.indexOf(id)
    const [low, high] = from < to ? [from, to] : [to, from]
    return { selected: order.slice(low, high + 1), anchor }
  }
  if (shift) {
    // 没有锚点：把这次点击当作范围起点
    return { selected: [id], anchor: id }
  }
  if (toggle) {
    const set = new Set(selected)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    // 锚点必须落在仍被选中的项上：新增时指向它，取消时退到剩余选择的最后一项
    const next = [...set]
    const anchorId = set.has(id) ? id : next.length ? next[next.length - 1] : null
    return { selected: next, anchor: anchorId }
  }
  return { selected: [id], anchor: id }
}
