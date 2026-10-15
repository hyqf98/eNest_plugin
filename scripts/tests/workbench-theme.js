/** Host token contract used by visual fixtures; a data-theme attribute alone is not a theme. */
export async function applyWorkbenchTheme(page, mode) {
  await page.evaluate(mode => {
    const common = { '--accent': mode === 'dark' ? '#e98654' : '#bd542b', '--accent-soft': mode === 'dark' ? '#e9865429' : '#bd542b1f', '--font': '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }
    const tokens = mode === 'dark'
      ? { '--bg': '#17191b', '--surface': '#202326', '--surface-2': '#292d31', '--surface-3': '#33383d', '--text': '#f2f3f3', '--text-2': '#adb3b8', '--text-3': '#7e878f', '--border': '#f2f3f317', '--border-strong': '#f2f3f329', '--shadow-float': '0 10px 32px #0006' }
      : { '--bg': '#f6f6f4', '--surface': '#ffffff', '--surface-2': '#eeefed', '--surface-3': '#e5e7e4', '--text': '#292c2e', '--text-2': '#666c70', '--text-3': '#82888b', '--border': '#292c2e14', '--border-strong': '#292c2e29', '--shadow-float': '0 8px 28px #292c2e14' }
    for (const [key, value] of Object.entries({ ...common, ...tokens })) document.documentElement.style.setProperty(key, value)
    document.documentElement.dataset.theme = mode
    document.documentElement.dataset.scheme = mode
    window.SshWorkbenchBridge?.activeSession()?.term?.setTheme?.()
  }, mode)
}
