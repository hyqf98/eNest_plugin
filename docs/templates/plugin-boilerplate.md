# 插件样板片段（plugin boilerplate）

跨插件逐字节相同的 canonical 片段。**新插件从这里复制；勿手改**——要改先在本文档定稿，再同步到各插件。

片段来源：`com.enest.codec` / `com.enest.password-kit` 等 9 个插件共用的那套值。

## JS：toast / isPerm / $ / failToast

```js
const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const toast = async (message, type = 'info') => {
  try { await api?.ui?.toast?.({ message, type }) } catch {}
}
const isPerm = (err) => String(err?.message || err).includes('permission denied')
const failToast = (e, permName) =>
  toast(isPerm(e) ? '缺少 ' + permName + ' 权限' : String(e?.message || e), 'error')
```

- `toast` 需声明 `ui.toast` 权限；未声明时静默（try/catch 容错）。
- `isPerm` 匹配壳子权限拒绝文案 `permission denied`，用于区分「缺权限」与「宿主/网络错误」。
- `failToast` 在 catch 里一行给出可读错误：`failToast(e, 'clipboard.write')`。

## CSS：深色兜底色板变量块

themeAware 注入会覆盖这些值；兜底保证浏览器直开 / 宿主未注入时可读。
色值与壳子 `THEME_TOKEN_PRESETS.dark`（`src/shared/theme/presets.ts`）一致：

```css
:root {
  color-scheme: dark;
  /* 主题 token 兜底（themeAware 注入会覆盖这些值） */
  --bg: #17191b;
  --surface: #202326;
  --surface-2: #292d31;
  --surface-3: #33383d;
  --border: rgba(242, 243, 243, 0.09);
  --border-strong: rgba(242, 243, 243, 0.16);
  --text: #f2f3f3;
  --text-2: #adb3b8;
  --text-3: #7e878f;
  --accent: #e98654;
  --ok: #77bfa4;
  --danger: #e79589;
}
```

需要派生面层时按需追加（同样 canonical）：

```css
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
  --danger-soft: color-mix(in srgb, var(--danger) 10%, transparent);
  --ring: color-mix(in srgb, var(--accent) 70%, transparent);
  --well: color-mix(in srgb, var(--bg) 84%, #000);
  --panel: color-mix(in srgb, var(--surface) 50%, var(--bg));

  --mono: "SF Mono", "JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace;
  --ui: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --ease: cubic-bezier(0.2, 0.7, 0.25, 1);
```

## 使用说明

- 复制顺序：`api` / `$` / `toast` / `isPerm` / `failToast` 放 JS 顶部；色板块放 `<style>` 的 `:root`。
- 主题包切换（含插件自注册 pack）只覆盖以上 token；插件自识色应引用 `var(--accent)` 等而非写死色值。
- 字体与缓动变量（`--mono` / `--ui` / `--ease`）仅按需携带，不算必备片段。
