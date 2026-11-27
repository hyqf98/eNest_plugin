/**
 * 详情页资源列表：每行是一个可下载的资源，行尾带下载按钮，点哪个就下哪个（不需要先选中）。
 * 文件夹类型的行点击后展开子项，面包屑可返回；warehousing（打包中）的行禁用。
 * 天翼云分享链接走 share.parse（ShareParseResult：根层 files，子文件夹 folders）；
 * ode 普通文件夹 id 走 library.detail(`${itemId}#folderId`)。
 */

import { useCallback, useEffect, useState } from 'react'
import { DownloadSimple, FolderOpen } from '@phosphor-icons/react'
import type { DetailData, ResourcePackage, ShareParseResult } from '../../shared/contracts'
import { ErrorBar, Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import * as api from '../../js/api'

interface FolderLevel {
  title: string
  items: ResourcePackage[]
}

/**
 * 把分享解析结果转成资源包行。
 * 文件行的 id 用「分享链接#文件id」：后端据此只下载这一个文件（分享链接是 ode 资源包的 id，
 * 单独选包时下载的是整个分享）。文件夹行保持文件夹 id，可继续展开。
 */
function shareEntriesToPackages(parsed: ShareParseResult, shareUrl: string): ResourcePackage[] {
  const files = parsed.files.map(file => ({
    id: `${shareUrl}#${file.id}`,
    name: file.name,
    sizeText: file.sizeText,
    size: file.size,
    provider: '天翼云盘',
    state: 'ready' as const,
    exePath: '',
    updatedAt: '',
  }))
  const folders = parsed.folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    sizeText: '',
    size: 0,
    provider: '文件夹',
    state: 'folder' as const,
    exePath: '',
    updatedAt: '',
  }))
  return [...folders, ...files]
}

export function PackageList({ detail, onDownload, downloadBusy }: {
  detail: DetailData
  /** 点了某个资源的下载按钮：带着那一个资源包打开下载确认 */
  onDownload: (pkg: ResourcePackage) => void
  /** 正在创建任务的资源包 id：同一行按钮防连点，其余行不受影响 */
  downloadBusy: string
}) {
  const [stack, setStack] = useState<FolderLevel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 详情切换时收起展开的文件夹
  useEffect(() => { setStack([]); setError('') }, [detail.item.id])

  const items = stack.length ? stack[stack.length - 1].items : detail.packages

  const openFolder = useCallback(async (pkg: ResourcePackage) => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      let files: ResourcePackage[] = []
      const isCloudShare = /cloud\.189\.cn/.test(pkg.id) || pkg.id.startsWith('http')
      if (isCloudShare) {
        // 天翼云分享：share.parse 返回根层 files 与子文件夹 folders
        const url = pkg.id.startsWith('http') ? pkg.id : `https://cloud.189.cn/t/${pkg.id}`
        const code = /[?&]pwd=([^&]+)/.exec(url)?.[1] ?? ''
        const parsed = await api.share.parse(url, code)
        files = shareEntriesToPackages(parsed, url)
      } else {
        // ode 普通文件夹：library.detail 展开子包
        const sub = await api.library.detail(`${detail.item.id}#${pkg.id}`)
        files = sub.packages
      }
      setStack(current => [...current, { title: pkg.name, items: files }])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [detail.item.id, loading])

  const level = stack.length

  return (
    <div className="gh-pkg">
      {level > 0 ? (
        <>
          <div className="gh-pkg-head">
            <h3>资源</h3>
            <button type="button" className="pk-btn pk-btn-sm" onClick={() => setStack(current => current.slice(0, -1))}>
              <Glyph icon={FolderOpen} size={12} /><span>返回上级</span>
            </button>
          </div>
          <nav className="gh-pkg-crumb" aria-label="文件夹路径">
            <button type="button" className="gh-pkg-crumb-link" onClick={() => setStack([])}>{detail.item.title}</button>
            {stack.map((item, index) => (
              <span key={index} className="gh-pkg-crumb-item">
                <span aria-hidden="true">/</span>
                {index === level - 1
                  ? <span className="gh-pkg-crumb-current">{item.title}</span>
                  : <button type="button" className="gh-pkg-crumb-link" onClick={() => setStack(current => current.slice(0, index + 1))}>{item.title}</button>}
              </span>
            ))}
          </nav>
        </>
      ) : null}
      {error ? <ErrorBar message={error} onRetry={() => setError('')} /> : null}
      {loading ? <Spinner label="正在加载文件夹内容…" /> : null}
      {!loading && !items.length ? <p className="gh-pkg-empty">这个条目下暂时没有可下载的资源</p> : null}
      <div className="gh-pkg-list">
        {items.map(pkg => {
          const isFolder = pkg.state === 'folder'
          const ready = pkg.state === 'ready'
          return (
            <div
              key={pkg.id}
              className="gh-row gh-pkg-row"
              data-disabled={ready || isFolder ? undefined : 'true'}
              tabIndex={isFolder ? 0 : undefined}
              onClick={() => { if (isFolder) void openFolder(pkg) }}
              onKeyDown={event => {
                if (!isFolder || (event.key !== 'Enter' && event.key !== ' ')) return
                event.preventDefault()
                void openFolder(pkg)
              }}
            >
              <div className="gh-row-main">
                <strong title={pkg.name}>{pkg.name}</strong>
                <small>
                  <span className="gh-pkg-meta-item">{isFolder ? <><Glyph icon={FolderOpen} size={11} />文件夹</> : pkg.provider || '资源'}</span>
                  {pkg.sizeText ? <span className="gh-pkg-meta-item">{pkg.sizeText}</span> : null}
                  {pkg.updatedAt ? <span className="gh-pkg-meta-item">{pkg.updatedAt}</span> : null}
                  {pkg.childCount ? <span className="gh-pkg-meta-item">{pkg.childCount} 个文件</span> : null}
                </small>
              </div>
              {pkg.state === 'warehousing' ? (
                <span className="gh-pkg-warn">此资源正在打包中</span>
              ) : isFolder ? (
                <button type="button" className="pk-btn pk-btn-sm gh-pkg-action" onClick={event => { event.stopPropagation(); void openFolder(pkg) }}>
                  <Glyph icon={FolderOpen} size={12} /><span>查看</span>
                </button>
              ) : ready ? (
                <button
                  type="button"
                  className="pk-btn pk-btn-sm pk-btn-primary gh-pkg-action"
                  aria-label={`下载 ${pkg.name}`}
                  disabled={downloadBusy !== ''}
                  onClick={event => { event.stopPropagation(); onDownload(pkg) }}
                >
                  <Glyph icon={DownloadSimple} size={12} /><span>{downloadBusy === pkg.id ? '启动中…' : '下载'}</span>
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
