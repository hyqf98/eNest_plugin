/**
 * settingsTip — 设置页「i」说明图标
 *
 * 设置项的解释文字原先以 .wb-setting-note / .muted 段落平铺在页面里，
 * 一屏能堆七八段说明，真正要操作的行反而被淹没。这里把说明收进悬浮提示
 * （tips.js 的浮动层，position:fixed 挂 body，不会被滚动容器裁切）：
 * 页面上只留一个 14px 的圆形 i，鼠标悬停或键盘聚焦时弹出。
 *
 * 说明文本必须是可信的静态文案；调用方传入用户数据时要自己先转义。
 */

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成一个说明图标。放进标题行（h2/h3/summary/标签）末尾使用。
 * tabindex 让键盘也能聚焦弹出提示；aria-label 供读屏器读取同一段说明。
 */
export function infoTip(text) {
  const safe = escAttr(text)
  if (!safe) return ''
  return `<span class="wb-info" data-tip="${safe}" role="img" tabindex="0" aria-label="${safe}">i</span>`
}
