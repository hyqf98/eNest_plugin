import test from "node:test";
// 开发者工具套件（regex / cron / diff / hash）的 Playwright 冒烟：
// 复用 dual-mode-tools.spec.mjs 的模式 —— 本地 http server + 注入 window.enest mock。
// 默认跳过；DEV_TOOLS_UI=1 时运行（需要本机 Chrome）。
import assert from "node:assert/strict";
import { createPreviewServer } from "../dev-server.mjs";
import { existsSync } from "node:fs";

const plugins = [
  { slug: "regex", quick: ["#pattern", "#samples", "#fill-sample"], shell: ["#toggle-sheet", "#snippet-form"] },
  { slug: "cron", quick: ["#expression", "#fire-list"], shell: ["#fields", "#crontab-parse"] },
  { slug: "diff", quick: ["#source", "#target"], shell: ["#opt-inline", "#export-diff"] },
  { slug: "hash", quick: ["#hash-input"], shell: ["#tab-crypto", "#tab-jwt", "#hmac-key"] },
];

test(
  "dev tools render in quick and shell modes without page errors",
  { skip: process.env.DEV_TOOLS_UI !== "1", timeout: 240000 },
  async () => {
    const { chromium } = await import("@playwright/test");
    const { server } = await createPreviewServer();
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-proxy-server"],
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 760, height: 520 } });
    await context.addInitScript(() => {
      const callbacks = {};
      const register = (name) => (cb) => {
        (callbacks[name] ||= []).push(cb);
        return () => {
          callbacks[name] = callbacks[name].filter((f) => f !== cb);
        };
      };
      const mode = new URLSearchParams(location.search).get("mode") || "quick";
      window.enest = {
        getLaunchMode: () => mode,
        onModeChange: register("mode"),
        onEnter: register("enter"),
        onOut: register("out"),
        onBeforeClose: register("close"),
        onDestroy: register("destroy"),
        ui: {
          setTitle: async () => {},
          setHeight: async () => {},
          setInputContext: async () => {},
          openInShell: async () => {},
          openSettings: async () => {},
          toast: async () => {},
          onThemeChange: register("theme"),
        },
        quickInput: {
          configure: async () => {},
          onChange: register("query"),
          onAction: register("action"),
          escape: async () => {},
        },
        settings: {
          get: async () => undefined,
          set: async () => true,
          onChange: register("setting"),
        },
        storage: {
          get: async (key) => JSON.parse(localStorage.getItem("smoke:" + key) ?? "null"),
          set: async (key, value) => {
            localStorage.setItem("smoke:" + key, JSON.stringify(value));
            return true;
          },
          remove: async (key) => {
            localStorage.removeItem("smoke:" + key);
            return true;
          },
        },
        clipboard: {
          readText: async () => "",
          writeText: async () => true,
        },
      };
    });
    context.setDefaultTimeout(8000);
    try {
      for (const plugin of plugins) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("response", (r) => {
          if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push("HTTP " + r.status() + " " + r.url());
        });
        const url = `http://127.0.0.1:${server.address().port}/plugins/${plugin.slug}/index.html?mode=quick`;
        await page.goto(url);
        await page.waitForTimeout(300);
        assert.equal(await page.locator("html").getAttribute("data-mode"), "quick", plugin.slug + " quick mode");
        for (const selector of plugin.quick) {
          assert.equal(await page.locator(selector).isVisible().catch(() => false), true, `${plugin.slug} quick ${selector}`);
        }
        // 无横向溢出
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
          true,
          plugin.slug + " quick overflow",
        );
        // shell 入口直开再验一遍（容器迁移由壳子负责，这里直接以 ?mode=shell 加载）
        await page.goto(`http://127.0.0.1:${server.address().port}/plugins/${plugin.slug}/index.html?mode=shell`);
        await page.waitForTimeout(300);
        assert.equal(await page.locator("html").getAttribute("data-mode"), "shell", plugin.slug + " shell mode");
        // hash 桌面形态默认在哈希 Tab，先切到加密 Tab 再断言其入口
        if (plugin.slug === "hash") await page.locator("#tab-crypto").click();
        for (const selector of plugin.shell) {
          assert.equal(
            await page.locator(selector).isVisible().catch(() => false),
            true,
            `${plugin.slug} shell ${selector}`,
          );
        }
        assert.deepEqual(errors, [], plugin.slug + " page errors");
        await page.close();
      }
    } finally {
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
);
