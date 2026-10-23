/**
 * markdown v2 —— 导出：HTML 单文件 / PDF（系统打印）/ PNG 长图。
 * 无独立 UI：经 forwardRef 暴露 { html, pdf, png } 给「⋯」菜单调用。
 */
import { forwardRef, useImperativeHandle } from 'react'
import { renderDocument } from '../render/render.js'
import { builtinThemeCss } from '../render/theme.js'
import { resolveImageToDataUrl, blobToDataUrl } from '../js/rpc.js'

export const ExportMenu = forwardRef(function ExportMenu({ docPath, textRef, darkMode, toast }, ref) {
  useImperativeHandle(ref, () => ({
    html: exportHtml,
    pdf: exportPdf,
    png: exportPng,
  }))

  /** 渲染完整文档并等待水合（图片/mermaid），返回 #write 元素 */
  async function renderAndWait() {
    const write = renderDocument(textRef.current, {
      mode: 'document',
      renderHtml: true,
      resolveImage: (url) => resolveImageToDataUrl(docPath, url),
    })
    await new Promise((r) => setTimeout(r, 1200))
    // 导出场景把 blob: 换回 dataUrl（脱离本页后 blob URL 失效）
    const blobs = Array.from(write.querySelectorAll('img[src^="blob:"]'))
    for (const img of blobs) {
      try { img.src = await blobToDataUrl(img.getAttribute('src')) } catch { /* 保留 */ }
    }
    return write
  }

  async function exportHtml() {
    try {
      const write = await renderAndWait()
      const themeCss = builtinThemeCss(darkMode ? 'enest-minimal-dark' : 'enest-minimal')
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${(docPath.split('/').pop() || '文档').replace(/\.md$/i, '')}</title>
<style>
body { margin: 0; background: ${darkMode ? '#1e2126' : '#f7f6f3'}; }
${themeCss}
</style>
</head>
<body><div class="md-scope">${write.outerHTML}</div></body>
</html>`
      const api = (window).enest || (window).zapi
      const result = await api?.shell?.saveTextFile?.({
        defaultName: `${(docPath.split('/').pop() || 'document').replace(/\.md$/i, '')}.html`,
        content: html,
      })
      if (result?.ok) toast('HTML 已导出', 'success')
    } catch (e) {
      toast(`导出失败：${e.message}`, 'error')
    }
  }

  async function exportPdf() {
    try {
      document.documentElement.classList.add('md-printing')
      await new Promise((r) => setTimeout(r, 400))
      window.print()
    } finally {
      setTimeout(() => document.documentElement.classList.remove('md-printing'), 800)
    }
  }

  async function exportPng() {
    try {
      const { toPng } = await import('html-to-image')
      const write = await renderAndWait()
      const holder = document.createElement('div')
      holder.className = 'md-scope md-export-stage'
      holder.appendChild(write)
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;background:#fff;padding:32px 28px;'
      document.body.appendChild(holder)
      await new Promise((r) => setTimeout(r, 300))
      const dataUrl = await toPng(holder, { pixelRatio: 2, backgroundColor: darkMode ? '#1e2126' : '#ffffff' })
      holder.remove()
      const api = (window).enest || (window).zapi
      const result = await api?.shell?.saveFile?.({
        defaultName: `${(docPath.split('/').pop() || 'document').replace(/\.md$/i, '')}.png`,
        dataUrl,
      })
      if (result?.ok) toast('长图已导出', 'success')
    } catch (e) {
      toast(`导图失败：${e.message}`, 'error')
    }
  }

  return null
})
