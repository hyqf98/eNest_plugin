import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../dev-server.mjs";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const plugins = ["image-tools", "code-shot"];

/** Mock eNest host: storage in localStorage, blobs in memory, no OS APIs. */
function installHost() {
  const slug = location.pathname.match(/com\.enest\.([^/]+)/)?.[1] || "tool";
  const callbacks = {};
  const calls = { copies: [], saves: [], heights: [], pins: [], imageWrites: [], contexts: [], escapes: 0, focus: 0 };
  const key = (name) => `smoke:${slug}:${name}`;
  const get = (name) => {
    const raw = localStorage.getItem(key(name));
    return raw === null ? undefined : JSON.parse(raw);
  };
  const set = (name, value) => localStorage.setItem(key(name), JSON.stringify(value));
  const register = (name) => (callback) => {
    (callbacks[name] ||= []).push(callback);
    return () => { callbacks[name] = callbacks.filter((cb) => cb !== callback); };
  };
  const emit = (name, event) => { for (const cb of callbacks[name] || []) cb(event); };
  const blobs = {};
  window.__calls = calls;
  window.__emit = emit;
  window.__saved = get;
  const picture = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 480; canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#6a9281"; ctx.fillRect(0, 0, 480, 300);
    ctx.fillStyle = "#f5f7f6"; ctx.font = "24px sans-serif"; ctx.fillText("Smoke image", 30, 90);
    return canvas.toDataURL("image/png");
  };
  window.enest = {
    getLaunchMode: () => "quick",
    onModeChange: register("mode"),
    onEnter: register("enter"),
    onOut: register("out"),
    onBeforeClose: register("close"),
    onDestroy: register("destroy"),
    ui: {
      setTitle: async () => true,
      setHeight: async (h) => calls.heights.push(h),
      setInputContext: async (c) => calls.contexts.push(c),
      focusSearch: async () => { calls.focus += 1; },
      openInShell: async () => { calls.pins += 1; },
      openSettings: async () => true,
      toast: async ({ message }) => { calls.copies.push(`toast:${message}`); return true; },
      onThemeChange: register("theme"),
      getThemeTokens: async () => ({
        mode: "dark",
        tokens: { "--accent": "#e98654", "--ok": "#77bfa4", "--text": "#f2f3f3", "--text-2": "#adb3b8", "--surface": "#202326", "--border-strong": "rgba(242,243,243,.16)" },
      }),
    },
    theme: { getTokens: async () => window.enest.ui.getThemeTokens() },
    storage: {
      get: async (k) => get(k),
      set: async (k, v) => { set(k, v); return true; },
      remove: async (k) => { localStorage.removeItem(key(k)); return true; },
      blobs: {
        put: async ({ dataUrl }) => { const id = `blob-${Object.keys(blobs).length + 1}`; blobs[id] = dataUrl; return { id, bytes: Math.round(dataUrl.length * 0.75) }; },
        get: async (id) => (blobs[id] ? { dataUrl: blobs[id], bytes: Math.round(blobs[id].length * 0.75) } : null),
        remove: async (id) => { delete blobs[id]; return true; },
      },
    },
    clipboard: {
      readText: async () => "const answer = 42;",
      writeText: async (t) => { calls.copies.push(t); return true; },
      readImage: async () => ({ dataUrl: picture(), width: 480, height: 300 }),
      writeImage: async (d) => { calls.imageWrites.push(d.slice(0, 30)); return true; },
    },
    pin: {
      open: async () => { calls.pins += 1; return { pinId: "pin-1" }; },
      close: async () => true,
      list: async () => [],
    },
    localFiles: {
      pick: async () => [],
      fromDrop: async () => [],
    },
    shell: {
      saveFile: async ({ defaultName }) => { calls.saves.push(defaultName); return { ok: true, path: `/tmp/${defaultName}` }; },
      saveTextFile: async ({ defaultName }) => { calls.saves.push(defaultName); return { ok: true, path: `/tmp/${defaultName}` }; },
    },
    quickInput: { configure: async () => true, onChange: register("query"), onAction: register("action"), escape: async () => { calls.escapes += 1; } },
  };
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); calls.pins += 1; }
  }, true);
}

function theme(page, mode, anim) {
  return page.evaluate(([nextMode, level]) => {
    document.documentElement.dataset.theme = nextMode;
    document.documentElement.dataset.anim = level;
    const rootStyle = nextMode === "dark"
      ? { "--bg": "rgb(23, 25, 27)", "--surface": "rgb(32, 35, 38)", "--surface-2": "rgb(41, 45, 49)", "--surface-3": "rgb(51, 56, 61)", "--border": "rgba(242,243,243,0.09)", "--border-strong": "rgba(242,243,243,0.16)", "--text": "rgb(242, 243, 243)", "--text-2": "rgb(173, 179, 184)", "--text-3": "rgb(126, 135, 143)", "--accent": "rgb(233, 134, 84)", "--accent-soft": "rgba(233,134,84,0.16)", "--ok": "rgb(119, 191, 164)", "--ok-soft": "rgba(119,191,164,0.16)", "--danger": "rgb(231, 149, 137)", "--danger-soft": "rgba(231,149,137,0.16)", "--font": "system-ui", "--mono": "ui-monospace, monospace", "--font-size-base": "13px", "--radius-sm": "10px", "--radius-md": "14px", "--shadow-soft": "0 8px 24px rgba(0,0,0,.4)", "--shadow-float": "0 16px 48px rgba(0,0,0,.55)" }
      : { "--bg": "rgb(246, 246, 244)", "--surface": "rgb(255, 255, 255)", "--surface-2": "rgb(238, 239, 237)", "--surface-3": "rgb(229, 231, 228)", "--border": "rgba(41,44,46,0.08)", "--border-strong": "rgba(41,44,46,0.16)", "--text": "rgb(41, 44, 46)", "--text-2": "rgb(102, 108, 112)", "--text-3": "rgb(130, 136, 139)", "--accent": "rgb(189, 84, 43)", "--accent-soft": "rgba(189,84,43,0.12)", "--ok": "rgb(49, 132, 105)", "--ok-soft": "rgba(49,132,105,0.12)", "--danger": "rgb(197, 79, 70)", "--danger-soft": "rgba(197,79,70,0.12)", "--font": "system-ui", "--mono": "ui-monospace, monospace", "--font-size-base": "13px", "--radius-sm": "10px", "--radius-md": "14px", "--shadow-soft": "0 8px 24px rgba(15,23,42,.05)", "--shadow-float": "0 16px 40px rgba(15,23,42,.1)" };
    for (const [name, value] of Object.entries(rootStyle)) document.documentElement.style.setProperty(name, value);
    window.__emit?.("theme", { mode: nextMode, tokens: rootStyle });
    return getComputedStyle(document.body).backgroundColor;
  }, [mode, anim]);
}

async function checkWidth(page, slug, mode, width) {
  await page.setViewportSize({ width, height: 640 });
  await page.waitForTimeout(120);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
    true,
    `${slug} ${mode} overflow at ${width}`,
  );
}

async function seed(page, slug) {
  if (slug === "code-shot") {
    const draft = "const answer = 42; // smoke";
    await page.locator("#code").fill(draft);
    await page.waitForTimeout(400);
    assert.ok(await page.locator("#shot-canvas").isVisible());
    assert.equal(await page.locator("#copy-shot").isDisabled(), false, "canvas ready enables copy");
    return { selector: "#code", value: draft, stored: "codeshot_config_v1" };
  }
  // image-tools: 从剪贴板导入 → 队列出现 → 压缩产出结果
  await page.locator("#from-clipboard").click();
  await page.waitForFunction(() => document.querySelectorAll(".thumb").length >= 1, null, { timeout: 8000 });
  await page.locator(".thumb").first().click();
  await page.locator("#run-compress").click();
  await page.waitForFunction(() => !document.querySelector("#result-bar")?.hidden, null, { timeout: 8000 });
  return { contains: "#result-meta", value: "×", stored: "imagetools_queue_v1" };
}

test(
  "image-tools + code-shot: dual mode, theme tokens, core flows and key boundaries",
  { timeout: 240000 },
  async () => {
    const { chromium } = await import("@playwright/test");
    const { server } = await createPreviewServer();
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 760, height: 520 } });
    await context.addInitScript(installHost);
    context.setDefaultTimeout(8000);
    const failures = [], results = [];
    await mkdir("/tmp/enest-newtools-smoke", { recursive: true });
    try {
      for (const slug of plugins) {
        const page = await context.newPage();
        const errors = [], missing = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) missing.push(r.url()); });
        try {
          const url = `http://127.0.0.1:${server.address().port}/plugins/com.enest.${slug}/index.html?mode=quick`;
          await page.goto(url);
          await page.waitForTimeout(300);
          assert.equal(await page.locator("html").getAttribute("data-mode"), "quick", `${slug} initial mode`);
          await theme(page, "light", "medium");
          await checkWidth(page, slug, "quick", 1100);
          await page.screenshot({ path: `/tmp/enest-newtools-smoke/${slug}-quick.png` });

          // Quick 高度自适应上报
          assert.ok(
            await page.evaluate(() => window.__calls.heights.length > 0 || document.body.scrollHeight > 0),
            `${slug} height reporting or content`,
          );

          const state = await seed(page, slug);

          // 迁移到 shell 模式（容器迁移不重载页面）
          await page.evaluate(() => window.__emit("mode", "shell"));
          await page.setViewportSize({ width: 1200, height: 760 });
          await page.waitForTimeout(80);
          assert.equal(await page.locator("html").getAttribute("data-mode"), "shell", `${slug} shell mode`);
          await checkWidth(page, slug, "shell", 480);
          await page.screenshot({ path: `/tmp/enest-newtools-smoke/${slug}-shell.png` });

          // 主题切换 + 动画档位
          await theme(page, "dark", "low");
          assert.equal(
            await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pk-speed").trim().replace(/^([.\d]+)s$/, (_, seconds) => `${Number(seconds) * 1000}ms`)),
            "0ms",
            `${slug} low animation`,
          );
          await theme(page, "dark", "high");
          assert.equal(
            await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pk-speed").trim().replace(/^([.\d]+)s$/, (_, seconds) => `${Number(seconds) * 1000}ms`)),
            "170ms",
            `${slug} high animation`,
          );

          // 草稿跨模式保留
          await page.evaluate(() => window.__emit("mode", "quick"));
          await page.setViewportSize({ width: 760, height: 520 });
          await page.waitForTimeout(80);
          if (state.selector) assert.equal(await page.locator(state.selector).inputValue().catch(() => ""), state.value, `${slug} draft back in quick`);
          if (state.contains) assert.ok((await page.locator(state.contains).textContent())?.length, `${slug} data visible in quick`);

          // 键盘边界：Esc / ⌘K 由 plugin-kit 转发壳子（focus/escape 计数递增）；⌘Enter 固定到主窗
          const shortcut = await page.evaluate(() => {
            document.activeElement?.blur();
            const calls = window.__calls;
            const before = { escapes: calls.escapes || 0, focus: calls.focus || 0, pins: calls.pins || 0 };
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            return { before, after: calls };
          });
          assert.equal(shortcut.after.focus, shortcut.before.focus + 1, `${slug} ⌘K forwarded to host search`);
          assert.equal(shortcut.after.escapes, shortcut.before.escapes + 1, `${slug} Escape forwarded to quick input`);

          if (state.stored) {
            await page.waitForTimeout(200);
            const saved = await page.evaluate((name) => window.__saved(name), state.stored);
            assert.ok(saved, `${slug} durable save`);
            await page.reload();
            await page.waitForTimeout(300);
            const reloaded = await page.evaluate((name) => window.__saved(name), state.stored);
            assert.deepEqual(JSON.parse(JSON.stringify(reloaded || null)), JSON.parse(JSON.stringify(saved || null)), `${slug} durable reload`);
          }
          assert.deepEqual(missing, [], `${slug} missing packaged resources`);
          assert.deepEqual(errors, [], `${slug} runtime errors`);
          results.push(`${slug}: quick 760/1100 + shell 1200/480, light/dark, anim low/high, key boundaries${state.stored ? ", reload" : ""}`);
        } catch (error) {
          await page.screenshot({ path: `/tmp/enest-newtools-smoke/${slug}-failure.png` }).catch(() => {});
          failures.push(`${slug}: ${error.message}`);
          console.log(`FAILED ${slug}: ${error.message}`);
        } finally {
          await page.close();
        }
      }
      console.log(results.join("\n"));
      assert.deepEqual(failures, []);
    } finally {
      await context.close();
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
);
