/**
 * 文件保存 — 终点：把上游图片落盘到本机。
 *
 * 两种保存方式（参数选择）：
 * - folder：先经原生选择器挑一个文件夹（backend.node 后端），运行时把所有上游图
 *   批量写入该文件夹（文件名 = 前缀-序号.扩展名）；重复运行覆盖同名文件。
 * - dialog：逐张弹系统保存框选路径（shell.saveFile，无后端环境可用）。
 */
import { defineNode, PORT_KIND, PARAM_TYPE } from '../nodeSchema.mjs'
import { registerNode } from '../nodeRegistry.mjs'
import { getAsset } from '../assets.mjs'
import { saveAssetToDirectory } from '../backendBridge.mjs'

registerNode(defineNode({
  type: 'fileSave',
  title: '文件保存',
  glyph: '⤓',
  category: '输出',
  description: '把上游图片批量保存到选定文件夹',
  protocol: null,
  runnable: true,
  inputs: [{ key: 'image', label: '图片', kind: PORT_KIND.IMAGE, optional: false, multiple: true }],
  outputs: [],
  params: [
    { key: 'mode', type: PARAM_TYPE.SELECT, label: '方式', default: 'folder', options: [
      { label: '保存到文件夹（批量）', value: 'folder' },
      { label: '逐张另存为…', value: 'dialog' }
    ] },
    { key: 'directory', type: PARAM_TYPE.DIRECTORY, label: '目标文件夹', default: null },
    { key: 'prefix', type: PARAM_TYPE.TEXT, label: '文件名前缀', default: 'ai-canvas', placeholder: '默认 ai-canvas' }
  ],
  async execute({ inputs, params }) {
    const images = Array.isArray(inputs.image) ? inputs.image : (inputs.image ? [inputs.image] : [])
    if (!images.length) throw new Error('缺少输入图：请连接上游图片节点')
    const prefix = String(params.prefix ?? '').trim() || 'ai-canvas'
    const enest = window.enest || window.zapi

    if (params.mode === 'dialog') {
      if (!enest?.shell?.saveFile) throw new Error('宿主保存接口不可用，请升级 eNest')
      const saved = []
      const skipped = []
      for (const [index, ref] of images.entries()) {
        const asset = await getAsset(ref.assetId)
        if (!asset?.dataUrl) { skipped.push(index + 1); continue }
        const ext = (asset.mime?.split('/')[1] || 'png').replace('jpeg', 'jpg')
        const res = await enest.shell.saveFile({ defaultName: `${prefix}-${index + 1}.${ext}`, dataUrl: asset.dataUrl })
        if (res?.ok && res.path) saved.push(res.path)
        else skipped.push(index + 1)
      }
      if (!saved.length) throw new Error('未保存任何图片（用户在保存框中取消了全部选择）')
      return { outputs: {}, display: { saved, skipped } }
    }

    // folder 模式：需要已选目录（参数里存 handleId + 展示路径）
    const dir = params.directory
    if (!dir?.handleId) throw new Error('尚未选择目标文件夹：点击「目标文件夹」的「选择文件夹」按钮')
    const saved = []
    const skipped = []
    for (const [index, ref] of images.entries()) {
      const asset = await getAsset(ref.assetId)
      if (!asset?.dataUrl) { skipped.push(index + 1); continue }
      const ext = (asset.mime?.split('/')[1] || 'png').replace('jpeg', 'jpg')
      const path = await saveAssetToDirectory({ handleId: dir.handleId, name: `${prefix}-${index + 1}.${ext}`, dataUrl: asset.dataUrl })
      saved.push(path)
    }
    if (!saved.length) throw new Error('未保存任何图片（资源缺失或目录授权失效）')
    return { outputs: {}, display: { saved, skipped } }
  }
}))
