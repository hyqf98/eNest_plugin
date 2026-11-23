/**
 * 网盘搜索：未搜索时居中大搜索框 + 网盘类型胶囊；搜索后顶部紧凑搜索行 +
 * 按网盘分组的结果列表。天翼结果可一键「下载」（打开粘贴链接对话框）。
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Cloud, Copy, DownloadSimple, HardDrive, MagnifyingGlass, X } from '@phosphor-icons/react'
import type { PanSouResult } from '../../shared/contracts'
import { Button } from '../../ui'
import { Empty, ErrorBar, Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { PasteLinkDialog } from './PasteLinkDialog'

const CLOUD_TYPES = [
  { id: 'tianyi', label: '天翼' },
  { id: 'ali', label: '阿里' },
  { id: 'quark', label: '夸克' },
]

const TYPE_LABELS: Record<string, string> = {
  tianyi: '天翼云盘',
  ali: '阿里云盘',
  quark: '夸克网盘',
  baidu: '百度网盘',
}

export function PanSouView() {
  const app = useApp()
  const [keyword, setKeyword] = useState('')
  const [types, setTypes] = useState<string[]>(['tianyi', 'ali', 'quark'])
  const [searched, setSearched] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [response, setResponse] = useState<{ total: number; groups: Array<{ type: string; label: string; results: PanSouResult[] }> } | null>(null)
  const [serviceDown, setServiceDown] = useState(false)
  const [paste, setPaste] = useState<{ open: boolean; url: string; code: string }>({ open: false, url: '', code: '' })
  const inputRef = useRef<HTMLInputElement>(null)

  // 进入栏目时探测服务可用性（不轮询）
  useEffect(() => {
    let alive = true
    void api.panSou.health().then(health => { if (alive) setServiceDown(!health.available) }).catch(() => { if (alive) setServiceDown(true) })
    return () => { alive = false }
  }, [])

  async function search(word: string, cloudTypes: string[]): Promise<void> {
    const kw = word.trim()
    if (!kw) return
    setKeyword(kw)
    setSearched(kw)
    setLoading(true)
    setError('')
    try {
      const result = await api.panSou.search(kw, cloudTypes)
      setResponse(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResponse(null)
    } finally { setLoading(false) }
  }

  function toggleType(id: string): void {
    const next = types.includes(id) ? types.filter(item => item !== id) : [...types, id]
    if (!next.length) return
    setTypes(next)
    if (searched) void search(searched, next)
  }

  function reset(): void {
    setKeyword(''); setSearched(''); setResponse(null); setError('')
    void Promise.resolve(inputRef.current?.focus())
  }

  return (
    <div className="gh-ps" data-mode={searched ? 'results' : 'home'}>
      {serviceDown ? (
        <div className="gh-set-expired" role="alert" style={{ background: 'var(--danger-soft, rgba(180, 76, 80, .12))', color: 'var(--danger, #b44c50)' }}>
          <span>PanSou 服务暂不可用，可在设置中检查服务地址</span>
          <Button size="sm" onClick={() => app.setNav('settings')}>去设置</Button>
        </div>
      ) : null}

      {!searched ? (
        <div className="gh-ps-home">
          <div className="gh-ps-logo">
            <Glyph icon={MagnifyingGlass} size={44} className="gh-ps-logo-icon" />
            <h2 className="gh-ps-title">网盘搜索</h2>
          </div>
          <div className="gh-ps-center">
            <div className="gh-ps-searchbar gh-ps-searchbar-lg">
              <Glyph icon={MagnifyingGlass} size={16} className="gh-ps-search-icon" />
              <input
                ref={inputRef}
                value={keyword}
                placeholder="输入游戏名称搜索网盘资源…"
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void search(keyword, types) }}
                aria-label="搜索网盘资源"
              />
              {keyword ? (
                <button type="button" className="gh-search-clear" onClick={reset} aria-label="清空">
                  <Glyph icon={X} size={12} />
                </button>
              ) : null}
            </div>
            <div className="gh-ps-chips" role="group" aria-label="网盘类型">
              {CLOUD_TYPES.map(type => (
                <Button
                  key={type.id}
                  size="sm"
                  pressed={types.includes(type.id)}
                  aria-pressed={types.includes(type.id)}
                  onClick={() => toggleType(type.id)}
                >
                  <Glyph icon={type.id === 'quark' ? HardDrive : Cloud} size={13} />
                  <span>{type.label}</span>
                </Button>
              ))}
            </div>
            <Button variant="primary" onClick={() => void search(keyword, types)} disabled={!keyword.trim() || serviceDown} className="gh-ps-go">
              <Glyph icon={MagnifyingGlass} size={14} />
              <span>搜索</span>
            </Button>
            <Button variant="ghost" onClick={() => setPaste({ open: true, url: '', code: '' })} className="gh-ps-paste">
              <Glyph icon={DownloadSimple} size={14} />
              <span>粘贴链接下载</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="gh-ps-results-page">
          <div className="gh-ps-header">
            <button type="button" className="gh-ps-back" onClick={reset} aria-label="返回搜索首页">网盘搜索</button>
            <div className="gh-ps-searchbar gh-ps-searchbar-sm">
              <Glyph icon={MagnifyingGlass} size={14} className="gh-ps-search-icon" />
              <input
                value={keyword}
                placeholder="搜索网盘资源…"
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void search(keyword, types) }}
                aria-label="搜索网盘资源"
              />
              {keyword ? (
                <button type="button" className="gh-search-clear" onClick={reset} aria-label="清空">
                  <Glyph icon={X} size={12} />
                </button>
              ) : null}
            </div>
            <div className="gh-ps-chips" role="group" aria-label="网盘类型">
              {CLOUD_TYPES.map(type => (
                <Button
                  key={type.id}
                  size="sm"
                  pressed={types.includes(type.id)}
                  aria-pressed={types.includes(type.id)}
                  onClick={() => toggleType(type.id)}
                >
                  <span>{type.label}</span>
                </Button>
              ))}
            </div>
            <span className="gh-toolbar-spacer" />
            <Button size="sm" variant="ghost" onClick={() => setPaste({ open: true, url: '', code: '' })}>
              <Glyph icon={DownloadSimple} size={13} />
              <span>粘贴链接下载</span>
            </Button>
          </div>

          {error ? <ErrorBar message={error} onRetry={() => void search(searched, types)} /> : null}
          {loading ? <Spinner label="正在搜索网盘资源…" /> : null}
          {!loading && !error && response && response.total === 0 ? (
            <Empty title={`未找到「${searched}」相关的网盘资源`} body="换个关键词或选择更多网盘类型再试" />
          ) : null}

          {!loading && response && response.total > 0 ? (
            <div className="gh-ps-groups">
              {response.groups.filter(group => group.results.length > 0).map(group => (
                <PanSouGroup key={group.type} type={group.type} label={group.label} results={group.results} onDownload={result => setPaste({ open: true, url: result.url, code: result.accessCode })} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      <PasteLinkDialog
        open={paste.open}
        initialUrl={paste.url}
        initialCode={paste.code}
        onClose={() => setPaste({ open: false, url: '', code: '' })}
      />
    </div>
  )
}

/* ---------------- 分组 ---------------- */

function PanSouGroup({ type, label, results, onDownload }: {
  type: string
  label: string
  results: PanSouResult[]
  onDownload: (result: PanSouResult) => void
}) {
  return (
    <section className="gh-ps-group" aria-label={label}>
      <h3 className="gh-ps-group-title">
        <Glyph icon={type === 'quark' ? HardDrive : Cloud} size={15} />
        <span>{TYPE_LABELS[type] ?? label ?? type}</span>
        <span className="gh-ps-group-count">共 {results.length} 条结果</span>
      </h3>
      <div className="gh-list">
        {results.map((result, index) => (
          <ResultRow key={`${result.url}-${index}`} result={result} onDownload={() => onDownload(result)} />
        ))}
      </div>
    </section>
  )
}

/* ---------------- 单条结果 ---------------- */

function ResultRow({ result, onDownload }: { result: PanSouResult; onDownload: () => void }) {
  const [copied, setCopied] = useState<'link' | 'code' | ''>('')
  const timer = useRef(0)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  async function copy(kind: 'link' | 'code', value: string): Promise<void> {
    try {
      await api.host.copyText(value)
    } catch {
      // 无剪贴板权限时回退到 execCommand，再失败才提示
      try {
        const helper = document.createElement('textarea')
        helper.value = value
        helper.style.position = 'fixed'
        helper.style.opacity = '0'
        document.body.appendChild(helper)
        helper.select()
        document.execCommand('copy')
        helper.remove()
      } catch {
        void api.host.toast('复制失败', 'error')
        return
      }
    }
    setCopied(kind)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(''), 1600)
  }

  return (
    <div className="gh-ps-row">
      <div className="gh-ps-row-main">
        <div className="gh-ps-note">{result.note || result.url}</div>
        <div className="gh-ps-meta">
          {result.datetime ? <span>{result.datetime}</span> : null}
          {result.source ? <span>来源 {result.source}</span> : null}
          <span className="gh-ps-url" title={result.url}>{result.url}</span>
        </div>
      </div>
      <div className="gh-ps-row-actions">
        {result.accessCode ? (
          <Button size="sm" variant="ghost" onClick={() => void copy('code', result.accessCode)} aria-label="复制提取码">
            <Glyph icon={copied === 'code' ? Check : Copy} size={12} />
            <span>{copied === 'code' ? '已复制' : `提取码 ${result.accessCode}`}</span>
          </Button>
        ) : null}
        {result.downloadable ? (
          <Button size="sm" onClick={onDownload}>
            <Glyph icon={DownloadSimple} size={13} />
            <span>下载</span>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void copy('link', result.url)}>
          <Glyph icon={copied === 'link' ? Check : Copy} size={13} />
          <span>{copied === 'link' ? '已复制' : '复制链接'}</span>
        </Button>
      </div>
    </div>
  )
}

/** 类型标识到中文名的映射，供分组标题使用 */
export function panSouTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}
