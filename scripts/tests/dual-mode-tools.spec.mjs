import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../dev-server.mjs";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
const plugins = [
  "clipboard",
  "todos",
  "sticky-notes",
  "pomodoro",
  "translate",
  "calculator",
  "timestamp",
  "codec",
  "json-tools",
  "password-kit",
  "qrcode",
  "screen-assistant",
  "color-picker",
];

// The host APIs are mocked; operating-system permissions, capture and native paste
// remain integration checks. This suite never contacts a translation provider.
function installHost() {
  const slug = location.pathname.match(/com\.enest\.([^/]+)/)?.[1] || "tool";
  const callbacks = {},
    calls = {
      copies: [],
      saves: [],
      contexts: [],
      heights: [],
      escapes: 0,
      focus: 0,
      pins: 0,
      imageReads: [],
      historyCopies: [],
      removed: [],
    };
  const key = (name) => `smoke:${slug}:${name}`;
  const get = (name) => {
    const raw = localStorage.getItem(key(name));
    return raw === null ? undefined : JSON.parse(raw);
  };
  const set = (name, value) => {
    localStorage.setItem(key(name), JSON.stringify(value));
  };
  const register = (name) => (callback) => {
    (callbacks[name] ||= []).push(callback);
    return () => {
      callbacks[name] = callbacks[name].filter((cb) => cb !== callback);
    };
  };
  const emit = (name, event) => {
    for (const cb of callbacks[name] || []) cb(event);
  };
  window.__calls = calls;
  window.__emit = emit;
  window.__saved = get;
  const picture = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#6a9281";
    ctx.fillRect(0, 0, 480, 300);
    ctx.fillStyle = "#f5f7f6";
    ctx.font = "24px sans-serif";
    ctx.fillText("Local capture smoke", 30, 90);
    return canvas.toDataURL("image/png");
  };
  let timer = get("timer") || {
    state: {
      status: "idle",
      phase: "focus",
      cycle: 1,
      remainingMs: 1500000,
      options: {
        focusMin: 25,
        breakMin: 5,
        longBreakMin: 15,
        longBreakEvery: 4,
        task: "",
      },
    },
    records: [],
  };
  const timerUpdate = (status) => {
    timer.state.status = status;
    set("timer", timer);
    emit("timer", timer);
    return structuredClone(timer);
  };
  const history = get("clipboard-items") || [
    {
      id: "clip-1",
      type: "text",
      text: "本地剪贴板测试内容",
      preview: "本地剪贴板测试内容",
      ts: Date.now(),
      bytes: 30,
      pinned: false,
      sourceApp: { id: "com.test.editor", name: "编辑器" },
    },
    {
      id: "clip-2",
      type: "files",
      preview: "测试文件.txt",
      ts: Date.now() - 60000,
      bytes: 120,
      pinned: true,
      files: [
        { name: "测试文件.txt", path: "/tmp/测试文件.txt", exists: false },
      ],
      sourceApp: { name: "Finder", id: "com.apple.finder" },
    },
  ];
  window.enest = {
    getLaunchMode: () => "quick",
    onModeChange: register("mode"),
    onEnter: register("enter"),
    onOut: register("out"),
    onBeforeClose: register("close"),
    onDestroy: register("destroy"),
    ui: {
      setTitle: async () => {},
      setHeight: async (h) => calls.heights.push(h),
      setInputContext: async (c) => calls.contexts.push(c),
      focusSearch: async () => {
        calls.focus++;
      },
      openInShell: async () => {
        calls.pins++;
      },
      openSettings: async () => {},
      toast: async () => {},
      onThemeChange: register("theme"),
    },
    quickInput: {
      configure: async (v) => {
        calls.query = v.value;
      },
      onChange: register("query"),
      onAction: register("action"),
      escape: async () => {
        calls.escapes++;
      },
    },
    settings: {
      get: async (name) => get("setting:" + name),
      set: async (name, value) => {
        set("setting:" + name, value);
        emit("setting", { key: name, value });
      },
      onChange: register("setting"),
    },
    storage: {
      get: async (name) => get(name),
      set: async (name, value) => set(name, value),
      remove: async (name) => localStorage.removeItem(key(name)),
      blobs: {
        put: async ({ dataUrl, name }) => {
          const id = crypto.randomUUID();
          set("blob:" + id, { dataUrl, name });
          return { id };
        },
        get: async (id) => get("blob:" + id),
        remove: async (id) => localStorage.removeItem(key("blob:" + id)),
      },
    },
    clipboard: {
      readText: async () => "",
      writeText: async (text) => calls.copies.push(text),
      writeImage: async (dataUrl) => {
        window.__image = dataUrl;
      },
      readImage: async () => ({ dataUrl: window.__image || picture() }),
      capabilities: async () => ({
        paste: false,
        permissionRequired: false,
        reason: "浏览器模拟环境，仅验证复制",
      }),
      requestPermission: async () => false,
      history: {
        query: async ({
          query = "",
          type,
          pinned,
          cursor = 0,
          limit = 60,
        } = {}) => {
          const items = history.filter(
            (i) =>
              (!type || i.type === type) &&
              (!pinned || i.pinned) &&
              (!query || (i.text || i.preview).includes(query)),
          );
          return {
            items: items.slice(cursor, cursor + limit),
            total: items.length,
            nextCursor: cursor + limit < items.length ? cursor + limit : null,
          };
        },
        get: async (id) => {
          const item = history.find((v) => v.id === id);
          if (item?.type === "image") {
            calls.imageReads.push(id);
            return { ...item, dataUrl: picture() };
          }
          return item;
        },
        onChange: register("clipboard"),
        copy: async (id, options) => {
          calls.historyCopies.push({ id, options });
          const item = history.find((v) => v.id === id);
          calls.copies.push(
            options?.paths
              ? item.files.map((file) => file.path).join("\n")
              : item?.text || id,
          );
        },
        paste: async (id) => ({ pasted: false, reason: "测试环境" }),
        togglePin: async (id) => {
          const entry = history.find((v) => v.id === id);
          entry.pinned = !entry.pinned;
          set("clipboard-items", history);
        },
        remove: async (id) => {
          calls.removed.push(id);
          const index = history.findIndex((item) => item.id === id);
          if (index >= 0) history.splice(index, 1);
          set("clipboard-items", history);
        },
        clear: async () => {
          for (let i = history.length - 1; i >= 0; i--)
            if (!history[i].pinned) history.splice(i, 1);
          set("clipboard-items", history);
        },
        reveal: async () => false,
      },
    },
    shell: {
      saveTextFile: async (data) => {
        calls.saves.push(data);
        return { ok: true, path: "/tmp/smoke.txt" };
      },
      saveFile: async (data) => {
        calls.saves.push(data);
        return { ok: true, path: "/tmp/smoke.png" };
      },
      openExternal: async () => true,
    },
    focusTimer: {
      get: async () => structuredClone(timer),
      onChange: register("timer"),
      start: async (opts) => {
        timer.state.options = opts;
        timer.state.remainingMs = opts.focusMin * 60000;
        return timerUpdate("running");
      },
      pause: async () => timerUpdate("paused"),
      resume: async () => timerUpdate("running"),
      stop: async () => timerUpdate("idle"),
      skip: async () => timerUpdate("idle"),
      updateRecord: async () => structuredClone(timer),
    },
    screen: {
      selectRegion: async () => ({ x: 0, y: 0, width: 480, height: 300 }),
      capture: async () => ({ dataUrl: picture(), width: 480, height: 300 }),
      record: {
        start: async () => ({ sessionId: "smoke" }),
        stop: async () => ({
          path: "/tmp/smoke.webm",
          size: 2000,
          durationMs: 2000,
        }),
        cancel: async () => true,
      },
    },
    pin: {
      list: async () => [],
      open: async () => ({ pinId: "smoke-pin" }),
      close: async () => true,
      closeAll: async () => 0,
    },
    net: {
      fetch: async () => {
        throw new Error("Smoke tests do not perform network requests");
      },
    },
    notify: async () => true,
  };
}

async function seed(page, slug) {
  const draft = `模式迁移草稿 ${slug}`;
  if (slug === "clipboard") {
    await page.evaluate(() => __emit("query", "本地"));
    await page.waitForTimeout(170);
    return { selector: "#search", value: "本地", stored: "clipboard.view.v2" };
  }
  if (slug === "todos") {
    await page.locator("#new-task").fill(draft);
    await page.locator("#new-task").press("Enter");
    await page.waitForTimeout(120);
    return { contains: "#tasks", value: draft, stored: "todos_v2" };
  }
  if (slug === "sticky-notes") {
    await page.locator("#quick-input").fill(draft);
    await page.locator("#quick-input").press("Enter");
    await page.locator("#body").waitFor();
    await page.locator("#body").fill(draft + "\n修改后的笔记");
    await page.waitForTimeout(500);
    return {
      selector: "#body",
      value: draft + "\n修改后的笔记",
      stored: "notes_v2",
    };
  }
  if (slug === "pomodoro") {
    await page.locator("#task").fill(draft);
    await page.locator("#toggle").click();
    return { selector: "#task", value: draft, stored: "timer" };
  }
  if (slug === "translate") {
    await page.locator("#input").fill(draft);
    return { selector: "#input", value: draft };
  }
  if (slug === "calculator") {
    await page.locator("#expr").fill("sqrt(144)+25");
    await page.locator("#expr").press("Enter");
    return { selector: "#expr", value: "37", stored: "calculator.history.v1" };
  }
  if (slug === "timestamp") {
    await page.locator("#input").fill("2026-10-13 10:20:30");
    return { selector: "#input", value: "2026-10-13 10:20:30" };
  }
  if (slug === "codec") {
    await page.locator("#input").fill(draft);
    await page.locator("#run").click();
    return { selector: "#input", value: draft };
  }
  if (slug === "json-tools") {
    const value = '{"大整数":900719925474099312345}';
    await page.locator("#input").fill(value);
    await page.locator("[data-action=format]").click();
    return { selector: "#input", value };
  }
  if (slug === "password-kit") {
    await page.locator("#count").fill("3");
    await page.locator("#generate").click();
    return { selector: "#count", value: "3" };
  }
  if (slug === "qrcode") {
    await page.locator("#input").fill(draft);
    await page.waitForTimeout(300);
    return { selector: "#input", value: draft };
  }
  if (slug === "screen-assistant") {
    await page.locator("#capture-full").click();
    await page.waitForFunction(
      () => document.querySelector("#copy-image").disabled === false,
    );
    return {
      contains: "#image-meta",
      value: "480",
      stored: "screen_workspace_v2",
    };
  }
  await page.locator("#color-input").fill("#305080");
  await page.locator("#remember").click();
  return {
    selector: "#color-input",
    value: "#305080",
    stored: "color_workspace_v2",
  };
}

async function theme(page, mode, animation) {
  return page.evaluate(
    ({ mode, animation }) => {
      const root = document.documentElement;
      root.dataset.theme = mode;
      root.dataset.anim = animation;
      const tokens =
        mode === "dark"
          ? {
              "--bg": "#1c2026",
              "--surface": "#252c35",
              "--text": "#e9edf2",
              "--text-2": "#bdc5d0",
              "--text-3": "#929dac",
              "--border": "#3a4452",
              "--accent": "#83abe1",
              "--primary": "#83abe1",
            }
          : {
              "--bg": "#fafbfc",
              "--surface": "#f1f4f7",
              "--text": "#283546",
              "--text-2": "#657487",
              "--text-3": "#778699",
              "--border": "#dce3eb",
              "--accent": "#4c719f",
              "--primary": "#4c719f",
            };
      for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
      return getComputedStyle(document.body).backgroundColor;
    },
    { mode, animation },
  );
}

const featureEntries = {
  clipboard: {
    quick: ["#manage", "#copy"],
    shell: ["#collection-filter", "#select-all"],
  },
  todos: { quick: ["#new-task"], shell: ["#new-list", "#import"] },
  "sticky-notes": { quick: ["#new"], shell: ["#layout", "#export-all"] },
  pomodoro: { quick: ["#toggle"], shell: ["#export", "#toggle"] },
  translate: { quick: ["#run"], shell: ["#history-toggle", "#export-current"] },
  calculator: {
    quick: ["#copy", "#toggle-pad"],
    shell: ["#memory-add", "#export"],
  },
  timestamp: {
    quick: ["#input", "[data-tab=date]"],
    shell: ["#zone", "[data-tab=batch]"],
  },
  codec: { quick: ["#run", "#copy"], shell: ["#batch", "#save"] },
  "json-tools": {
    quick: ["[data-action=format]", "#show-source"],
    shell: ["[data-view=diff]", "#save"],
  },
  "password-kit": {
    quick: ["#generate-copy"],
    shell: ["#exclude", "#copy-all"],
  },
  qrcode: {
    quick: ["#copy-image", "[data-tab=decode]"],
    shell: ["#template", "[data-tab=batch]"],
  },
  "screen-assistant": {
    quick: ["#capture", "#copy-image"],
    shell: ["#import-image", "[data-tab=record]"],
  },
  "color-picker": {
    quick: ["#capture", "#remember"],
    shell: ["#create-palette", "#export-css"],
  },
};

async function checkWidth(page, slug, mode, width) {
  await page.setViewportSize({ width, height: 760 });
  await page.waitForTimeout(60);
  assert.equal(
    await page.locator("html").getAttribute("data-mode"),
    mode,
    `${slug} ${width}px preserves ${mode} mode`,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
    true,
    `${slug} ${mode} ${width}px overflow`,
  );
  if (slug === "password-kit" && mode === "shell") {
    await page.locator(".advanced summary").click();
  }
  for (const selector of featureEntries[slug][mode]) {
    const entry = page.locator(selector);
    assert.equal(
      await entry.isVisible(),
      true,
      `${slug} ${mode} ${width}px feature entry ${selector}`,
    );
    const box = await entry.boundingBox();
    assert.ok(
      box && box.x >= -2 && box.x + box.width <= width + 2,
      `${slug} ${mode} ${width}px feature bounds ${selector}`,
    );
  }
}

async function clipboardCoverage(page) {
  await page.evaluate(() => {
    const base = { ts: Date.now(), bytes: 32, pinned: false };
    const text = (id, value) => ({
      ...base,
      id,
      type: "text",
      text: value,
      preview: value,
    });
    const picture = (id) => ({
      ...base,
      id,
      type: "image",
      width: 480,
      height: 300,
    });
    const fixtures = [
      text("text-a", "第一段合并文本"),
      {
        ...base,
        id: "file-missing",
        type: "files",
        preview: "失效文件.txt",
        files: [
          {
            name: "失效文件.txt",
            path: "/tmp/enest-missing.txt",
            exists: false,
          },
        ],
      },
      picture("image-visible"),
      text("text-b", "第二段合并文本"),
      ...Array.from({ length: 40 }, (_, i) =>
        text("filler-" + i, "历史记录 " + i),
      ),
      picture("image-lazy"),
    ];
    localStorage.setItem(
      "smoke:clipboard:clipboard-items",
      JSON.stringify(fixtures),
    );
    localStorage.setItem(
      "smoke:clipboard:clipboard.view.v2",
      JSON.stringify({
        query: "",
        type: "all",
        current: "text-a",
        collection: "",
        scroll: 0,
      }),
    );
    localStorage.removeItem("smoke:clipboard:clipboard.groups.v2");
  });
  await page.reload();
  await page.waitForFunction(() =>
    __calls.imageReads.includes("image-visible"),
  );
  assert.equal(
    await page.evaluate(() => __calls.imageReads.includes("image-lazy")),
    false,
    "clipboard image outside viewport loads lazily",
  );
  assert.match(
    await page.locator('[data-id="file-missing"] .source').textContent(),
    /未知来源/,
  );
  await page.evaluate(() => __emit("mode", "shell"));
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.locator('[data-id="file-missing"] .preview').click();
  assert.match(
    await page.locator("#detail .file.invalid").textContent(),
    /文件已移动或删除/,
  );
  assert.equal(await page.locator("#detail [data-reveal]").isDisabled(), true);
  await page.locator("#copy-paths").click();
  assert.equal(
    await page.evaluate(() => __calls.copies.at(-1)),
    "/tmp/enest-missing.txt",
  );

  await page.locator('[data-id="text-a"] .check').check();
  await page.locator('[data-id="text-b"] .check').check();
  await page.locator("#copy").click();
  assert.equal(
    await page.evaluate(() => __calls.copies.at(-1)),
    "第一段合并文本\n\n第二段合并文本",
  );
  await page.locator('[data-id="text-a"] .check').uncheck();
  await page.locator('[data-id="text-b"] .check').uncheck();

  await page.locator("#manage").click();
  await page.locator("#collections").fill("资料\n临时");
  await page.locator("#save-management").click();
  await page.locator("#manager").waitFor({ state: "hidden" });
  await page.locator('[data-id="text-a"] .preview').click();
  await page.locator("#assign-group").selectOption("资料");
  await page.locator("#collection-filter").selectOption("资料");
  await page.waitForFunction(
    () => document.querySelectorAll("#list .entry").length === 1,
  );
  assert.equal(
    await page.locator("#list .entry").getAttribute("data-id"),
    "text-a",
  );
  assert.equal(
    await page.evaluate(() => __saved("clipboard.groups.v2").entries["text-a"]),
    "资料",
  );
  await page.locator("#collection-filter").selectOption("");
  await page.waitForFunction(
    () => document.querySelectorAll("#list .entry").length === 45,
  );

  await page.locator("#delete").click();
  assert.match(
    await page.locator("#confirm-text").textContent(),
    /文件原件不会被删除/,
  );
  await page.locator("#confirm-cancel").click();
  assert.deepEqual(await page.evaluate(() => __calls.removed), []);
  await page.locator("#delete").click();
  await page.locator("#confirm-ok").click();
  await page.waitForFunction(
    () => !document.querySelector('[data-id="text-a"]'),
  );
  assert.deepEqual(await page.evaluate(() => __calls.removed), ["text-a"]);
  assert.ok(
    await page.evaluate(() =>
      __saved("clipboard-items").some((item) => item.id === "file-missing"),
    ),
  );

  await page.locator('[data-id="image-lazy"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => __calls.imageReads.includes("image-lazy"));
  await page.locator('[data-id="image-lazy"] .preview').click();
  await page.waitForFunction(
    () => document.querySelector("#detail .detail-image")?.complete,
  );
  assert.equal(
    await page.evaluate(
      () => __calls.imageReads.filter((id) => id === "image-lazy").length,
    ),
    1,
    "clipboard thumbnail and detail share image cache",
  );
}

test(
  "13 standalone tools: 52 viewport cases, theme tokens, draft transfer, durable data and key boundaries",
  { skip: process.env.DUAL_MODE_UI !== "1", timeout: 300000 },
  async () => {
    const { chromium } = await import("@playwright/test");
    const { server } = await createPreviewServer();
    const chrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const browser = await chromium.launch({
      headless: true,
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 760, height: 520 },
    });
    await context.addInitScript(installHost);
    context.setDefaultTimeout(8000);
    const results = [],
      failures = [];
    await mkdir("/tmp/enest-dual-mode-smoke", { recursive: true });
    try {
      for (const slug of plugins) {
        const page = await context.newPage(),
          errors = [],
          missing = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("response", (r) => {
          if (r.status() >= 400 && !r.url().endsWith("/favicon.ico"))
            missing.push(r.url());
        });
        try {
          const url = `http://127.0.0.1:${server.address().port}/plugins/com.enest.${slug}/index.html?mode=quick`;
          await page.goto(url);
          await page.waitForTimeout(250);
          assert.equal(
            await page.locator("html").getAttribute("data-mode"),
            "quick",
            slug + " initial mode",
          );
          const state = await seed(page, slug);
          assert.equal(
            await theme(page, "light", "medium"),
            "rgb(250, 251, 252)",
            slug + " light theme",
          );
          await page.screenshot({
            path: `/tmp/enest-dual-mode-smoke/${slug}-quick.png`,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 2,
            ),
            true,
            slug + " Quick overflow",
          );
          await checkWidth(page, slug, "quick", 1100);
          await page.evaluate(() => __emit("mode", "shell"));
          await page.setViewportSize({ width: 1200, height: 760 });
          await page.waitForTimeout(60);
          assert.equal(
            await page.locator("html").getAttribute("data-mode"),
            "shell",
            slug + " shell mode",
          );
          if (state.selector)
            assert.equal(
              await page.locator(state.selector).inputValue(),
              state.value,
              slug + " draft into shell",
            );
          if (state.contains)
            assert.ok(
              (await page.locator(state.contains).textContent()).includes(
                state.value,
              ),
              slug + " data into shell",
            );
          assert.equal(
            await theme(page, "dark", "low"),
            "rgb(28, 32, 38)",
            slug + " dark theme",
          );
          assert.equal(
            await page.evaluate(() =>
              getComputedStyle(document.documentElement)
                .getPropertyValue("--pk-speed")
                .trim().replace(/^([.\d]+)s$/, (_, seconds) => `${Number(seconds) * 1000}ms`),
            ),
            "0ms",
            slug + " low animation",
          );
          await page.screenshot({
            path: `/tmp/enest-dual-mode-smoke/${slug}-shell.png`,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 2,
            ),
            true,
            slug + " shell overflow",
          );
          await checkWidth(page, slug, "shell", 480);
          for (const [level, speed] of [
            ["low", "0ms"],
            ["medium", "120ms"],
            ["high", "170ms"],
          ]) {
            await theme(page, "dark", level);
            assert.equal(
              await page.evaluate(() =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--pk-speed")
                  .trim().replace(/^([.\d]+)s$/, (_, seconds) => `${Number(seconds) * 1000}ms`),
              ),
              speed,
              `${slug} ${level} animation speed`,
            );
          }
          await page.evaluate(() => __emit("mode", "quick"));
          await page.setViewportSize({ width: 760, height: 520 });
          await page.waitForTimeout(50);
          if (state.selector)
            assert.equal(
              await page.locator(state.selector).inputValue(),
              state.value,
              slug + " draft back to Quick",
            );
          const shortcut = await page.evaluate(() => {
            document.activeElement?.blur();
            const editor = Array.from(
              document.querySelectorAll(
                'textarea,input:not([type="checkbox"],[type="radio"],[type="file"],[type="range"])',
              ),
            ).find((element) => element.offsetWidth > 0);
            const target = editor || document.body;
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
            document.body.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "k",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
            document.body.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
              }),
            );
            return __calls;
          });
          assert.equal(shortcut.focus, 1, slug + " search shortcut");
          assert.equal(
            shortcut.pins,
            1,
            slug + " editor Mod+Enter pins to desktop",
          );
          assert.equal(shortcut.escapes, 1, slug + " Escape returns Quick");
          if (state.stored) {
            await page.waitForTimeout(160);
            const saved = await page.evaluate(
              (name) => __saved(name),
              state.stored,
            );
            assert.ok(saved, slug + " durable save");
            await page.reload();
            await page.waitForTimeout(250);
            const reloaded = await page.evaluate(
              (name) => __saved(name),
              state.stored,
            );
            assert.deepEqual(reloaded, saved, slug + " durable reload");
          }
          if (slug === "clipboard") await clipboardCoverage(page);
          assert.deepEqual(missing, [], slug + " missing packaged resources");
          assert.deepEqual(errors, [], slug + " runtime errors");
          results.push(
            slug +
              ": quick 760/1100 + shell 1200/480, light/dark, low/medium/high animation, drafts" +
              (state.stored ? ", reload" : "") +
              (slug === "clipboard"
                ? ", 45 mixed records + file/image/category/delete interactions"
                : ""),
          );
        } catch (error) {
          await page
            .screenshot({
              path: `/tmp/enest-dual-mode-smoke/${slug}-failure.png`,
            })
            .catch(() => {});
          failures.push(slug + ": " + error.message);
          console.log("FAILED " + slug + ": " + error.message);
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
