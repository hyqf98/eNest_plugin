/**
 * 媒体浏览：左树右网格，预览层覆盖其上。
 * 所有文件操作经后端；删除一律真删（单文件直删，批量与文件夹走原生确认）。
 */

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { FolderPlus } from '@phosphor-icons/react'
import type { FolderNode, MediaItem } from './shared/contracts'
import { useBrowser } from './js/useBrowser'
import { browser, onBackendExit, toast } from './js/api'
import { DRAG_TYPE, FolderTree, type TreeActions, type TreeLookup } from './js/FolderTree'
import { MediaGrid, type GridActions } from './js/MediaGrid'
import { Viewer } from './js/Viewer'
import { Button } from './ui/index'

type ClickEvent = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }

/** 从拖拽事件里取出条目 id 列表；不是自己的拖拽返回空 */
function draggedIds(event: DragEvent): string[] {
  const raw = event.dataTransfer.getData(DRAG_TYPE)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function App() {
  const state = useBrowser()
  const {
    rootList, tree, expanded, treeFiles, current, items, total, loading, error,
    gridSelected: gridSelectedIds, treeSelected: treeSelectedIds,
    openFolder, toggleExpand, clickGrid, clickTree, refreshTree, reloadCurrent, reportError, setError, addRoot, removeRoot: unlinkRoot,
  } = state
  const [thumbFailed, setThumbFailed] = useState<Set<string>>(new Set())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 后端异常退出后，已列出的内容和缩略图地址都已失效；给出可见提示，下次操作会由宿主重新拉起后端
  useEffect(() => onBackendExit(() => {
    setError('后台服务已意外退出，列表可能已过期。请重新点击文件夹刷新。')
    void toast('后台服务已意外退出，列表可能已过期', 'error')
  }), [setError])

  const roots = useMemo(() => tree.map(root => root.node), [tree])
  const gridSelected = useMemo(() => new Set(gridSelectedIds), [gridSelectedIds])
  const treeSelected = useMemo(() => new Set(treeSelectedIds), [treeSelectedIds])

  const lookup: TreeLookup = useMemo(() => ({
    isCollapsed: entryId => !expanded.has(entryId),
    childrenOf: entryId => {
      for (const root of tree) {
        if (root.node.entryId === entryId) return root.children
        if (root.expanded.has(entryId)) return root.expanded.get(entryId) ?? []
      }
      return []
    },
    filesOf: entryId => treeFiles.get(entryId) ?? [],
  }), [expanded, tree, treeFiles])

  const report = useCallback((result: { failed: { name: string; reason: string }[]; moved?: number; deleted?: number }, verb: string) => {
    const ok = (result.moved ?? result.deleted ?? 0) > 0 && !result.failed.length
    const skipped = result.failed.length
    if (skipped) {
      const first = result.failed[0]
      void toast(`${skipped} 个条目未能${verb}：${first.name} — ${first.reason}${skipped > 1 ? `（等 ${skipped} 项）` : ''}`, 'warn')
    } else if (ok) {
      void toast(`已${verb} ${result.moved ?? result.deleted} 个条目`, 'success')
    }
  }, [])

  /** 移动后刷新树与当前文件夹；被移走的条目不再存在，选择按名字保留 */
  /** 移动或删除后，当前文件夹里"仍被选中且没被移走/删除"的条目名字；用来保留选择 */
  const remainingSelectedNames = useCallback((removedIds: string[]) => {
    const gone = new Set(removedIds)
    return items.filter(item => gridSelectedIds.includes(item.entryId) && !gone.has(item.entryId)).map(item => item.name)
  }, [gridSelectedIds, items])

  /** 移动后刷新树与当前文件夹；被移走的条目不再存在，其余选择按名字保留 */
  const move = useCallback(async (ids: string[], target: FolderNode) => {
    const keptNames = remainingSelectedNames(ids)
    setBusy(true)
    try {
      const result = await browser.move(ids, target.entryId)
      report(result, '移动')
      await refreshTree()
      await reloadCurrent(keptNames)
    } catch (cause) {
      reportError(cause, '移动失败')
    } finally {
      setBusy(false)
    }
  }, [refreshTree, reloadCurrent, remainingSelectedNames, report, reportError])

  const dropOnFolder = useCallback((target: FolderNode, event: DragEvent) => {
    event.preventDefault()
    const ids = draggedIds(event)
    if (!ids.length) return
    void move(ids, target)
  }, [move])

  const open = useCallback((item: MediaItem) => {
    setViewerIndex(items.findIndex(entry => entry.entryId === item.entryId))
  }, [items])

  /** 删除：单文件直删；批量或文件夹由后端弹原生确认 */
  const remove = useCallback(async (ids: string[]) => {
    const keptNames = remainingSelectedNames(ids)
    setBusy(true)
    try {
      const result = await browser.remove(ids)
      if (result.cancelled) return false
      report(result, '删除')
      await refreshTree()
      await reloadCurrent(keptNames)
      setThumbFailed(new Set())
      return result.deleted > 0
    } catch (cause) {
      reportError(cause, '删除失败')
      return false
    } finally {
      setBusy(false)
    }
  }, [refreshTree, reloadCurrent, remainingSelectedNames, report, reportError])

  const deleteViewerItem = useCallback(async (item: MediaItem) => {
    const ok = await remove([item.entryId])
    if (ok) void toast(`已删除 ${item.name}`, 'success')
    return ok
  }, [remove])

  /**
   * 网格里的右键菜单（危险操作按规范放右键，不占工具栏）。
   * 与文件管理器一致：右键的目标已在选中项里 → 操作全部选中项；否则只操作这一张。右键本身不改变现有选择。
   */
  /** 树里已展开文件夹下的全部文件，摊平成一个列表 */
  const loadedTreeFiles = useCallback((): MediaItem[] => [...treeFiles.values()].flat(), [treeFiles])

  /**
   * 左侧树的右键菜单。文件：预览/删除；文件夹：删除整个文件夹（递归，后端弹原生确认）。
   * 与网格一致：目标已在选中项里则操作全部选中项。当前打开的文件夹不可删除。
   */
  const treeContextMenu = useCallback((node: FolderNode | MediaItem, event: { clientX: number; clientY: number; preventDefault(): void }) => {
    event.preventDefault()
    const isFolder = 'depth' in node
    if (!isFolder) {
      const item = node
      const inSelection = treeSelected.has(item.entryId)
      const targets = inSelection ? loadedTreeFiles().filter(entry => treeSelected.has(entry.entryId)) : [item]
      window.PluginKit?.openMenu(event, [
        ['open', '预览'],
        { sep: true },
        ['delete', targets.length > 1 ? `删除选中的 ${targets.length} 项` : '删除', { danger: true }],
      ], key => {
        if (key === 'open') open(item)
        if (key === 'delete') void remove(targets.map(entry => entry.entryId))
      })
      return
    }
    const isCurrent = node.entryId === current?.entryId
    // 根目录是用户关联的整个文件夹：不提供删除（后端同样拒绝），只提供取消关联——它不动磁盘上的文件
    if (node.depth === 0) {
      window.PluginKit?.openMenu(event, [
        ['open', '打开'],
        { sep: true },
        ['unlink', `取消关联「${node.name}」`, { danger: true }],
      ], key => {
        if (key === 'open') void openFolder(node)
        if (key === 'unlink') void unlinkRoot(node.rootId)
      })
      return
    }
    window.PluginKit?.openMenu(event, [
      ['open', '打开'],
      { sep: true },
      ['delete', `删除文件夹「${node.name}」`, { danger: true, disabled: isCurrent, hint: isCurrent ? '请先打开别的文件夹' : undefined }],
    ], key => {
      if (key === 'open') void openFolder(node)
      if (key === 'delete') void remove([node.entryId])
    })
  }, [current, loadedTreeFiles, open, openFolder, remove, treeSelected, unlinkRoot])

  const treeActions: TreeActions = useMemo(() => ({
    openFolder: node => { void openFolder(node) },
    toggleCollapse: node => { void toggleExpand(node) },
    clickTree: (node, event) => clickTree(node as FolderNode, event as ClickEvent),
    dropOnFolder,
    contextMenu: treeContextMenu,
  }), [clickTree, dropOnFolder, openFolder, treeContextMenu, toggleExpand])

  const gridContextMenu = useCallback((item: MediaItem, event: { clientX: number; clientY: number; preventDefault(): void }) => {
    event.preventDefault()
    const inSelection = gridSelected.has(item.entryId)
    const targets = inSelection ? items.filter(entry => gridSelected.has(entry.entryId)) : [item]
    window.PluginKit?.openMenu(event, [
      ['open', '预览'],
      { sep: true },
      ['delete', targets.length > 1 ? `删除选中的 ${targets.length} 项` : '删除', { danger: true }],
    ], key => {
      if (key === 'open') open(item)
      if (key === 'delete') void remove(targets.map(entry => entry.entryId))
    })
  }, [gridSelected, items, open, remove])

  const gridActions: GridActions = useMemo(() => ({
    clickGrid: (item, event) => clickGrid(item, event as ClickEvent),
    open,
    contextMenu: gridContextMenu,
  }), [clickGrid, gridContextMenu, open])

  const currentName = current?.name ?? ''
  const viewerOpen = viewerIndex !== null && viewerIndex >= 0 && items[viewerIndex] !== undefined

  return (
    <div className="mb-app">
      <aside className="mb-side" aria-label="文件夹">
        <div className="mb-side-head">
          <span className="mb-side-title">文件夹</span>
          <Button size="sm" variant="ghost" onClick={() => void addRoot()} disabled={busy} aria-label="关联文件夹">
            <FolderPlus size={16} aria-hidden="true" />
            <span>关联</span>
          </Button>
        </div>
        <div className="mb-side-body">
          {roots.length ? (
            <FolderTree roots={roots} lookup={lookup} selected={treeSelected} currentId={current?.entryId ?? null} actions={treeActions} />
          ) : (
            <div className="pk-empty-state">{loading ? '正在读取文件夹…' : '暂无已关联文件夹'}</div>
          )}
          {rootList.filter(root => root.missing).length ? (
            <div className="mb-missing">
              <p className="mb-missing-title">上次关联过（需重新授权）</p>
              {rootList.filter(root => root.missing).map(root => (
                <button key={root.displayPath} type="button" className="mb-missing-item" title="重新选择这个文件夹" onClick={() => void addRoot()}>
                  {root.displayPath}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      <main className="mb-main" aria-label={currentName}>
        <header className="mb-toolbar">
          <span className="mb-toolbar-title" title={currentName}>{currentName || '未选择文件夹'}</span>
          <span className="mb-toolbar-count">{total ? `${total} 项` : ''}</span>
          <span className="mb-toolbar-spacer" />
          {gridSelected.size ? <span className="mb-toolbar-count">已选 {gridSelected.size}</span> : null}
        </header>
        {error ? <div className="mb-error" role="alert">{error}</div> : null}
        {!roots.length && !loading ? (
          <div className="pk-empty-state">
            <p className="pk-empty-title">关联一个文件夹开始浏览</p>
            <p className="pk-empty-hint">支持常见图片、相机 RAW 和视频格式。</p>
            <Button variant="primary" disabled={busy} onClick={() => void addRoot()}>关联文件夹</Button>
          </div>
        ) : !current ? (
          <div className="pk-empty-state">
            {loading ? '正在读取媒体…' : '从左侧选择文件夹'}
          </div>
        ) : !items.length && !loading ? (
          <div className="pk-empty-state">这个文件夹里没有图片或视频</div>
        ) : (
          <MediaGrid items={items} selected={gridSelected} thumbFailed={thumbFailed}
            onThumbError={entryId => setThumbFailed(previous => new Set(previous).add(entryId))}
            actions={gridActions} />
        )}
        {loading && current ? <div className="mb-loading" role="status">读取中…</div> : null}
      </main>

      {viewerOpen ? (
        <Viewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onDelete={deleteViewerItem}
        />
      ) : null}
    </div>
  )
}
