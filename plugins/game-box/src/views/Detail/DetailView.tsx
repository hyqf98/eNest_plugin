/**
 * 详情视图：覆盖在主区之上的整页详情（返回行 + 轮播 + 状态区 + 介绍 + 侧栏）。
 * 数据来自 library.detail；任务状态经 useApp().tasks 实时驱动；
 * 资源包在 PackagePicker 里单选后经 DownloadDialog 确认创建任务。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowSquareOut, Clock, HardDrive, Heart } from '@phosphor-icons/react'
import type { DetailData, ResourcePackage } from '../../shared/contracts'
import { useApp } from '../../js/state'
import { Cover, Empty, ErrorBar, SkeletonGrid, Spinner, StatusBadge } from '../../components/base'
import { SanitizedHtml } from '../../components/ext'
import { Glyph } from '../../components/Glyph'
import * as api from '../../js/api'
import { Carousel } from './Carousel'
import { StatePanel } from './StatePanel'
import { PackagePicker } from './PackagePicker'
import { DownloadDialog } from './DownloadDialog'

export function DetailView({ itemId }: { itemId: string }) {
  const app = useApp()
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const requestSeq = useRef(0)

  const load = useCallback((keepContent = false) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    if (!keepContent) setDetail(null)
    api.library.detail(itemId)
      .then(result => {
        if (seq !== requestSeq.current) return
        setDetail(result)
        setLoading(false)
      })
      .catch(err => {
        if (seq !== requestSeq.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [itemId])

  useEffect(() => { load() }, [load])

  const task = useMemo(
    () => app.taskList.find(item => item.itemId === itemId) ?? null,
    [app.taskList, itemId],
  )

  // 可直接建任务的资源包。判据是"数据源给没给出可下载的包"，不是数据源名字：
  // 修改器 / MOD 也是直链包，同样走这里的下载流程。
  const selectablePackages = useMemo(
    () => (detail?.packages ?? []).filter(pkg => pkg.state === 'ready'),
    [detail],
  )
  // gamer520 这类手动下载源不给文件列表（fileList 恒为空），只能打开它的下载页
  const isManualSource = detail ? detail.item.source === 'gamer520' : false
  const downloadPageUrl = detail?.officialUrl ?? ''

  const onFavorite = async () => {
    if (!detail) return
    try {
      await api.library.favorite(detail.item.id, !detail.item.favorite)
      load(true)
    } catch (err) {
      void app.notify(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const openExternal = (url: string) => {
    if (!url) return
    void api.host.openExternal(url).catch(err => void app.notify(err instanceof Error ? err.message : String(err), 'error'))
  }

  const selectedPackages: ResourcePackage[] = useMemo(() => {
    if (!detail) return []
    const found = detail.packages.find(pkg => pkg.id === selectedPackageId)
    return found ? [found] : []
  }, [detail, selectedPackageId])

  const openDialog = () => {
    // 未选资源时默认选第一个可下载的包
    if (!selectedPackageId && selectablePackages.length) setSelectedPackageId(selectablePackages[0].id)
    setDialogOpen(true)
  }

  return (
    <div className="gh-detail">
      {/* 页头：与列表页的工具栏同高同基线（返回按钮 36px，下面同一条细线），所以从列表进详情时页头不会跳 */}
      <header className="gh-detail-head">
        <button type="button" className="gh-detail-back" onClick={app.closeDetail} aria-label="返回列表">
          <Glyph icon={ArrowLeft} size={16} />
          <span>返回</span>
        </button>
        <h2 className="gh-detail-head-title">{detail?.item.title || (loading ? '加载中…' : '详情')}</h2>
        {detail ? (
          <span className="gh-detail-head-meta">
            {[detail.item.category, detail.datetime].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </header>

      {loading && !detail ? (
        <div className="gh-detail-loading">
          <Spinner label="正在加载详情…" />
          <SkeletonGrid count={4} />
        </div>
      ) : error && !detail ? (
        <ErrorBar message={error} onRetry={() => load()} />
      ) : detail ? (
        <div className="gh-detail-body">
          <div className="gh-detail-main">
            <Carousel media={detail.media} />

            <StatePanel detail={detail} task={task} onDownload={openDialog} />

            {detail.description ? (
              <section className="gh-panel">
                <h3>详细介绍</h3>
                <SanitizedHtml html={detail.description} />
              </section>
            ) : null}

            {detail.trainerOptions.length ? (
              <section className="gh-panel">
                <h3>功能项</h3>
                <table className="gh-detail-table">
                  <thead>
                    <tr><th scope="col">名称</th><th scope="col">快捷键</th><th scope="col">说明</th></tr>
                  </thead>
                  <tbody>
                    {detail.trainerOptions.map(option => (
                      <tr key={`${option.name}:${option.hotkey}`}>
                        <td>{option.name}</td>
                        <td>{option.hotkey}</td>
                        <td>{option.text || option.tooltip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            {detail.trainerGuides.length ? (
              <section className="gh-panel">
                <h3>使用指南</h3>
                <ul className="gh-detail-guides">
                  {detail.trainerGuides.map(guide => (
                    <li key={guide.id}>
                      <button type="button" className="gh-detail-guide-link" onClick={() => openExternal(guide.url)}>
                        <span>{guide.title}</span>
                        <Glyph icon={ArrowSquareOut} size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="gh-detail-side">
            <section className="gh-panel gh-detail-info">
              <div className="gh-detail-cover"><Cover token={detail.item.coverToken} alt={detail.item.title} /></div>
              <div className="gh-detail-title-row">
                <h3 className="gh-detail-title">{detail.item.title}</h3>
                <button
                  type="button"
                  className="gh-detail-fav"
                  data-favorite={detail.item.favorite ? 'true' : 'false'}
                  aria-label={detail.item.favorite ? '取消收藏' : '收藏'}
                  aria-pressed={detail.item.favorite}
                  onClick={() => void onFavorite()}
                >
                  <Heart size={16} weight={detail.item.favorite ? 'fill' : 'regular'} />
                </button>
              </div>
              <div className="gh-detail-badges">
                {detail.item.category ? <StatusBadge>{detail.item.category}</StatusBadge> : null}
                {detail.item.subtitle ? <StatusBadge>{detail.item.subtitle}</StatusBadge> : null}
              </div>
              <dl className="gh-detail-facts">
                {detail.datetime ? (
                  <div className="gh-detail-fact"><dt>更新时间</dt><dd><Glyph icon={Clock} size={12} />{detail.datetime}</dd></div>
                ) : null}
                {detail.sizeText || detail.installedSizeText ? (
                  <div className="gh-detail-fact"><dt>大小</dt><dd><Glyph icon={HardDrive} size={12} />{detail.sizeText ? `下载大小：${detail.sizeText}` : ''}{detail.sizeText && detail.installedSizeText ? '（' : ''}{detail.installedSizeText ? `安装后约 ${detail.installedSizeText}` : ''}{detail.sizeText && detail.installedSizeText ? '）' : ''}</dd></div>
                ) : null}
              </dl>
              {detail.officialUrl ? (
                <button type="button" className="gh-detail-link" onClick={() => openExternal(detail.officialUrl)}>
                  <span>官方网站</span><Glyph icon={ArrowSquareOut} size={12} />
                </button>
              ) : null}
            </section>

            {detail.minConfig || detail.recommendConfig ? (
              <section className="gh-panel">
                <h3>配置要求</h3>
                <dl className="gh-detail-config">
                  {detail.minConfig ? <div><dt>最低配置</dt><dd>{detail.minConfig}</dd></div> : null}
                  {detail.recommendConfig ? <div><dt>推荐配置</dt><dd>{detail.recommendConfig}</dd></div> : null}
                </dl>
              </section>
            ) : null}

            <section className="gh-panel">
              {isManualSource ? (
                <>
                  <h3>下载资源</h3>
                  <p className="gh-detail-note">点击「打开下载页」将在浏览器中打开下载资源页面</p>
                  <button type="button" className="pk-btn pk-btn-primary gh-detail-page-btn" disabled={!downloadPageUrl} onClick={() => openExternal(downloadPageUrl)}>
                    <Glyph icon={ArrowSquareOut} size={14} /><span>打开下载页</span>
                  </button>
                </>
              ) : detail.packages.length ? (
                <>
                  {/* 有资源就交给 PackagePicker：打包中 / 文件夹 / 可下载都由它逐行表达。
                      此前按「有没有可下载的包」分流，PC 游戏站新上架的条目多半还在打包中，
                      整块被换成「暂无可下载的资源」，用户看不到资源其实存在、只是没传完。 */}
                  <PackagePicker detail={detail} selectedId={selectedPackageId} onSelect={pkg => setSelectedPackageId(pkg.id)} />
                  <button type="button" className="pk-btn pk-btn-primary gh-detail-next-btn" disabled={!selectedPackageId} onClick={openDialog}>
                    下一步
                  </button>
                </>
              ) : (
                <Empty title="暂无可下载的资源" body="这个条目下暂时没有可用的下载资源" />
              )}
            </section>
          </aside>
        </div>
      ) : null}

      {detail && !isManualSource ? (
        <DownloadDialog
          detail={detail}
          packages={selectedPackages}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onCreated={() => void app.refreshTasks()}
        />
      ) : null}
    </div>
  )
}
