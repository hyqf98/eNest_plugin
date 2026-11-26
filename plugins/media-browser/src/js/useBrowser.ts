/**
 * 浏览状态：根目录、左侧树的展开状态、当前文件夹及其分页内容、两个面板各自的选择。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FolderNode, MediaItem, RootEntry } from '../shared/contracts'
import { browser, roots, toast, type TreeRoot } from './api'
import { applySelection } from './selection'

const PAGE_SIZE = 200
/** 左侧树里每个文件夹最多列出的文件数；更多文件请在右侧网格里操作 */
const TREE_FILE_LIMIT = 500

/** 一个关联目录在树里的状态：后端返回的节点 + 展开时加载的更深层子文件夹 */
export interface TreeState extends TreeRoot {
  /** 已展开加载的更深层子文件夹：文件夹 entryId → 它的子节点 */
  expanded: Map<string, FolderNode[]>
}

export function useBrowser() {
  const [rootList, setRootList] = useState<RootEntry[]>([])
  const [tree, setTree] = useState<TreeState[]>([])
  /** 用户主动展开的文件夹；根目录默认展开 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 左侧树里已展开文件夹的文件：文件夹 entryId → 文件 */
  const [treeFiles, setTreeFiles] = useState<Map<string, MediaItem[]>>(new Map())
  const [current, setCurrent] = useState<FolderNode | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 切换文件夹时用递增的序号丢弃过期的列表结果 */
  const requestSeq = useRef(0)

  const [gridSelected, setGridSelected] = useState<string[]>([])
  const [gridAnchor, setGridAnchor] = useState<string | null>(null)
  const [treeSelected, setTreeSelected] = useState<string[]>([])
  const [treeAnchor, setTreeAnchor] = useState<string | null>(null)

  const reportError = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setError(message || fallback)
    void toast(message || fallback, 'error')
  }, [])

  /** 重新拉树；保留当前文件夹（若仍存在）与展开状态 */
  const refreshTree = useCallback(async () => {
    const next = await browser.tree()
    setTree(next.map(root => ({ ...root, expanded: new Map() })))
    // 根目录默认展开；已经展开过的深层文件夹保持展开
    setExpanded(previous => new Set([...next.map(root => root.node.entryId), ...previous]))
    return next
  }, [])

  const openFolder = useCallback(async (node: FolderNode) => {
    const seq = ++requestSeq.current
    setCurrent(node)
    setGridSelected([])
    setGridAnchor(null)
    setLoading(true)
    setError('')
    try {
      const page = await browser.folder(node.entryId, 0, PAGE_SIZE)
      if (seq !== requestSeq.current) return
      setItems(page.items)
      setTotal(page.total)
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setItems([])
      setTotal(0)
      reportError(cause, '读取文件夹失败')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [reportError])

  /** 重新读取当前文件夹（移动/删除后调用）。entryId 每次列表都会重新签发，所以按名字保留仍然存在的选择 */
  const reloadCurrent = useCallback(async (keepNames: string[] = []) => {
    if (!current) return
    const seq = ++requestSeq.current
    try {
      const page = await browser.folder(current.entryId, 0, PAGE_SIZE)
      if (seq !== requestSeq.current) return
      setItems(page.items)
      setTotal(page.total)
      const kept = new Set(page.items.filter(item => keepNames.includes(item.name)).map(item => item.entryId))
      setGridSelected(kept.size ? [...kept] : [])
      setGridAnchor(kept.size ? [...kept][0] : null)
    } catch (cause) {
      if (seq === requestSeq.current) reportError(cause, '刷新文件夹失败')
    }
  }, [current, reportError])

  const initialize = useCallback(async () => {
    try {
      const list = await roots.list()
      setRootList(list)
      await browser.origin()
      const next = await refreshTree()
      if (next.length && !current) await openFolder(next[0].node)
    } catch (cause) {
      reportError(cause, '初始化失败')
    }
  }, [current, openFolder, refreshTree, reportError])

  useEffect(() => { void initialize() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addRoot = useCallback(async () => {
    try {
      const result = await roots.add()
      if (!result) return
      setRootList(await roots.list())
      const next = await refreshTree()
      if (!result.added) { void toast('这个文件夹已经关联过了', 'info'); return }
      await openFolder(next.find(root => root.node.rootId === result.entry.rootId)?.node ?? next[0].node)
    } catch (cause) {
      reportError(cause, '关联文件夹失败')
    }
  }, [openFolder, refreshTree, reportError])

  const removeRoot = useCallback(async (rootId: string) => {
    try {
      const list = await roots.remove(rootId)
      setRootList(list)
      const next = await refreshTree()
      if (current?.rootId === rootId) {
        if (next.length) await openFolder(next[0].node)
        else { setCurrent(null); setItems([]); setTotal(0) }
      }
    } catch (cause) {
      reportError(cause, '移除关联失败')
    }
  }, [current, openFolder, refreshTree, reportError])

  /**
   * 切换左侧树里某个文件夹的折叠状态；展开时加载它的子文件夹与文件。
   * 深层子文件夹首次展开时从后端拉取并缓存到 root.expanded。
   */
  const toggleExpand = useCallback(async (node: FolderNode) => {
    const key = node.entryId
    // 还没展开过：展开并加载它的文件与子文件夹；已展开：折叠
    const willExpand = !expanded.has(key)
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!willExpand) return
    if (!treeFiles.has(key)) {
      browser.folder(key, 0, TREE_FILE_LIMIT).then(page => {
        setTreeFiles(previous => new Map(previous).set(key, page.items))
      }).catch(() => undefined)
    }
    // 根目录的直接子文件夹随 tree 一起下发，已经在 root.children 里；其它文件夹首次展开时拉取它的子文件夹
    if (node.depth === 0 || tree.some(root => root.expanded.has(key))) return
    const children = await browser.subfolders(key)
    setTree(previous => previous.map(root => {
      if (root.node.rootId !== node.rootId) return root
      return { ...root, expanded: new Map(root.expanded).set(key, children) }
    }))
  }, [expanded, tree, treeFiles])

  /** 左侧树的显示顺序：文件夹与其中已加载的文件，按渲染顺序排列 */
  const treeOrder = useMemo(() => {
    const order: string[] = []
    const visit = (node: FolderNode) => {
      order.push(node.entryId)
      if (!expanded.has(node.entryId)) return
      for (const item of treeFiles.get(node.entryId) ?? []) order.push(item.entryId)
      const children = tree.find(root => root.node.rootId === node.rootId)?.expanded.get(node.entryId) ?? []
      for (const child of children) visit(child)
    }
    for (const root of tree) {
      order.push(root.node.entryId)
      if (expanded.has(root.node.entryId)) {
        for (const item of treeFiles.get(root.node.entryId) ?? []) order.push(item.entryId)
        for (const child of root.children) visit(child)
      }
    }
    return order
  }, [expanded, tree, treeFiles])

  const clickGrid = useCallback((item: MediaItem, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const result = applySelection({
      selected: gridSelected, anchor: gridAnchor, id: item.entryId,
      shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey,
      order: items.map(entry => entry.entryId),
    })
    setGridSelected(result.selected)
    setGridAnchor(result.anchor)
  }, [gridAnchor, gridSelected, items])

  const clickTree = useCallback((node: FolderNode, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const result = applySelection({
      selected: treeSelected, anchor: treeAnchor, id: node.entryId,
      shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey,
      order: treeOrder,
    })
    setTreeSelected(result.selected)
    setTreeAnchor(result.anchor)
  }, [treeAnchor, treeOrder, treeSelected])

  return {
    rootList, tree, expanded, treeFiles, current, items, total, loading, error,
    gridSelected, treeSelected, treeOrder,
    addRoot, removeRoot, toggleExpand, openFolder, reloadCurrent, refreshTree,
    clickGrid, clickTree, setGridSelected, setGridAnchor, setTreeSelected, setTreeAnchor, setError, reportError,
  }
}
