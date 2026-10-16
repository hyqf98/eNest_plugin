import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const core = (id) =>
  import(
    pathToFileURL(
      resolve(root, "plugins", id, "src/js/core.mjs"),
    )
  );
const calc = await core("calculator"),
  time = await core("timestamp"),
  codec = await core("codec"),
  json = await core("json-tools"),
  password = await core("password-kit");
test("calculator preserves precedence, modulo, floating output and scientific operations", () => {
  assert.equal(calc.calculate("2+3*4"), 14);
  assert.equal(calc.calculate("7%4"), 3);
  assert.equal(calc.calculate("-2^2"), -4);
  assert.equal(calc.calculate("2^3^2"), 512);
  assert.equal(calc.formatNumber(calc.calculate("0.1+0.2")), "0.3");
  assert.equal(calc.calculate("sqrt(144)+pow(2,3)"), 20);
  assert.equal(calc.calculate("Ans+M", { ans: 7, memory: 3 }), 10);
  assert.equal(calc.calculate("sin(90)", { degrees: true }), 1);
  assert.equal(calc.calculate("1e3+2.5e-2"), 1000.025);
  for (const source of [
    "1/0",
    "sqrt(-1)",
    "unknown(2)",
    "pow(2)",
    "1;alert(1)",
    "2 3",
    "((2)",
    "1e999",
  ])
    assert.throws(() => calc.calculate(source));
});
test("timestamp accepts negative timestamps, explicit units, ISO and selected IANA timezone", () => {
  assert.equal(time.parseTime("-1", "s", "UTC"), -1000);
  assert.equal(time.parseTime("1000", "ms", "UTC"), 1000);
  assert.equal(time.parseTime("1700000000000", "auto", "UTC"), 1700000000000);
  assert.equal(
    time.parseTime("2026-10-13 08:00:00", "auto", "Asia/Shanghai"),
    Date.UTC(2026, 9, 13),
  );
  assert.equal(
    time.parseTime("2026-10-13T08:00:00+08:00"),
    Date.UTC(2026, 9, 13),
  );
  assert.equal(time.parseTime("+30m", "auto", "UTC", 1000), 1801000);
  assert.equal(time.parseTime("0", "auto", "UTC"), 0);
  assert.throws(() => time.parseTime("2026-02-30 12:00:00", "auto", "UTC"));
  assert.throws(() =>
    time.parseTime("2026-03-08 02:30:00", "auto", "America/New_York"),
  );
  assert.throws(() => time.parseTime("abc"));
  assert.equal(time.durationText(-90061000), "−1 天 1 小时 1 分 1 秒");
});
test("codec round trips Unicode and rejects malformed encodings instead of stale output", () => {
  for (const mode of ["base64", "base64url", "url", "hex", "unicode", "html"]) {
    const source = '中文🙂 <>&"\n';
    assert.equal(
      codec.convert(codec.convert(source, mode), mode, "decode"),
      source,
    );
  }
  for (const [text, mode] of [
    ["ff", "hex"],
    ["%%%", "base64"],
    ["A", "base64"],
    ["\\u12", "unicode"],
    ["%E0%A4", "url"],
    ["&#x110000;", "html"],
  ])
    assert.throws(() => codec.convert(text, mode, "decode"));
  assert.deepEqual(
    JSON.parse(codec.convert("https://a.test/?x=1&x=2", "query", "decode")),
    [
      ["x", "1"],
      ["x", "2"],
    ],
  );
  assert.equal(
    codec.convert('[["a","中 文"]]', "query"),
    "a=%E4%B8%AD+%E6%96%87",
  );
  assert.throws(() => codec.convert("{}", "query"));
  const jwt =
    codec.encodeBase64('{"alg":"none"}', true) +
    "." +
    codec.encodeBase64('{"sub":"123"}', true) +
    ".";
  assert.match(codec.convert(jwt, "jwt"), /签名未验证/);
  const rows = codec.convertLines("YQ==\n%%", "base64", "decode");
  assert.equal(rows[0].value, "a");
  assert.equal(rows[1].ok, false);
});
test("lossless JSON keeps every number token, duplicate key, order, and error location", () => {
  const source =
    '{"n":900719925474099312345,"decimal":1.2300000000000000001,"exp":1e+900,"n":-0}';
  const parsed = json.parseJson(source);
  assert.equal(json.stringifyJson(parsed.root, 0), source);
  assert.equal(parsed.stats.keys, 4);
  assert.equal(
    json.stringifyJson(json.parseJson('{"z":2,"a":1}').root, 0, true),
    '{"a":1,"z":2}',
  );
  for (const text of [
    '{"a":}',
    "[1,]",
    '{"a":01}',
    "true false",
    '"bad\nstring"',
    '{"__proto__":undefined}',
  ])
    assert.throws(() => json.parseJson(text), /第.*行第.*列/);
  assert.throws(
    () => json.parseJson('{\n"a":1,\n}'),
    (e) => e.position === 9 && /第 3 行第 1 列/.test(e.message),
  );
  assert.equal(json.unescapeText('"a\\nb"'), "a\nb");
  assert.equal(json.unescapeText("a\\nb"), "a\nb");
});
test("JSON tree search uses escaped pointers and diff distinguishes missing values and huge numbers", () => {
  const left = json.parseJson(
      '{"a/b":{"~key":9007199254740993},"n":null}',
    ).root,
    right = json.parseJson(
      '{"a/b":{"~key":9007199254740994},"new":false}',
    ).root;
  assert.equal(json.searchJson(left, "9007199")[0].path, "/a~1b/~0key");
  const changes = json.diffJson(left, right);
  assert.equal(changes.length, 3);
  assert.equal(changes[0].before, "9007199254740993");
  assert.deepEqual(
    json.diffJson(
      json.parseJson('{"a":1,"b":2}').root,
      json.parseJson('{"b":2,"a":1}').root,
    ),
    [],
  );
});
test("password generator covers selected sets and exclusions; UUID keeps RFC bits", () => {
  for (let i = 0; i < 100; i++) {
    const value = password.generatePassword(
      { length: 24, avoidAmbiguous: true, exclude: "!@" },
      webcrypto,
    );
    assert.equal(value.length, 24);
    assert.match(value, /[a-z]/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /\d/);
    assert.match(value, /[#$%^&*_=+?-]/);
    assert.doesNotMatch(value, /[O0oIl1|!@]/);
  }
  assert.throws(() => password.generatePassword({ sets: [] }, webcrypto));
  assert.throws(() =>
    password.generatePassword(
      { sets: ["digit"], exclude: "0123456789" },
      webcrypto,
    ),
  );
  assert.throws(() => password.generatePassword({ length: 2 }, webcrypto));
  assert.match(
    password.uuidV4({}, webcrypto),
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.match(
    password.uuidV4({ uppercase: true, hyphens: false }, webcrypto),
    /^[A-F0-9]{12}4[A-F0-9]{3}[89AB][A-F0-9]{15}$/,
  );
});
test(
  "utility UI: six plugins operate in Quick and desktop with preserved state",
  { skip: process.env.UTILITY_UI !== "1", timeout: 120000 },
  async () => {
    const { createPreviewServer } = await import("../dev-server.mjs");
    const { chromium } = await import("@playwright/test");
    const { existsSync } = await import("node:fs");
    const { server, url } = await createPreviewServer();
    const chrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const browser = await chromium.launch({
      headless: true,
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
    });
    try {
      for (const slug of [
        "calculator",
        "timestamp",
        "codec",
        "json-tools",
        "password-kit",
      ]) {
        const page = await browser.newPage({
          viewport: { width: 760, height: 520 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          const callbacks = {},
            store = {},
            settings = {};
          const register = (key) => (cb) => {
            (callbacks[key] ||= []).push(cb);
            return () => {
              callbacks[key] = callbacks[key].filter((v) => v !== cb);
            };
          };
          window.__calls = { copies: [], images: [], files: [], heights: [] };
          window.__emit = (key, event) => {
            for (const cb of callbacks[key] || []) cb(event);
          };
          window.enest = {
            getLaunchMode: () => "quick",
            onModeChange: register("mode"),
            onEnter: register("enter"),
            onOut: register("out"),
            onDestroy: register("destroy"),
            onBeforeClose: register("close"),
            ui: {
              setHeight: async (h) => __calls.heights.push(h),
              setTitle: async () => {},
              setInputContext: async () => {},
              focusSearch: async () => {},
            },
            quickInput: {
              configure: async () => {},
              onChange: register("query"),
              onAction: register("action"),
              escape: async () => {},
            },
            settings: {
              get: async (key) => settings[key],
              set: async (key, value) => {
                settings[key] = value;
              },
              onChange: register("setting"),
            },
            storage: {
              get: async (key) => store[key],
              set: async (key, value) => {
                store[key] = structuredClone(value);
              },
            },
            clipboard: {
              readText: async () => window.__clipboard || "",
              writeText: async (value) => __calls.copies.push(value),
              writeImage: async (dataUrl) => {
                __calls.images.push(dataUrl);
                window.__image = dataUrl;
              },
              readImage: async () => ({ dataUrl: window.__image }),
            },
            shell: {
              saveTextFile: async (data) => {
                __calls.files.push(data);
                return { ok: true };
              },
              saveFile: async (data) => {
                __calls.files.push(data);
                return { ok: true };
              },
              openExternal: async () => true,
            },
          };
        });
        await page.goto(
          `${url}/plugins/${slug}/index.html?mode=quick`,
        );
        await page.waitForTimeout(150);
        assert.equal(
          await page.locator("html").getAttribute("data-mode"),
          "quick",
          slug,
        );
        if (slug === "calculator") {
          await page.locator("#expr").fill("sqrt(144)+pow(2,3)");
          await page.locator("#expr").press("Enter");
          assert.equal(await page.locator("#result").textContent(), "20");
          await page
            .locator(".record")
            .first()
            .getByRole("button", { name: "复制", exact: true })
            .click();
          assert.equal(await page.evaluate(() => __calls.copies.at(-1)), "20");
          await page.locator(".record .star").first().click();
          await page.locator("#export").click();
          assert.match(
            await page.evaluate(() => __calls.files[0].content),
            /sqrt\(144\)/,
          );
        } else if (slug === "timestamp") {
          await page.locator("#zone").fill("Asia/Shanghai");
          await page.locator("#zone").dispatchEvent("change");
          await page.locator("#input").fill("-1");
          assert.match(
            await page.locator("#results").textContent(),
            /1970-01-01 07:59:59/,
          );
          await page.locator("[data-tab=batch]").click();
          await page.locator("#batch-input").fill("0\n-1\nbad");
          await page.locator("#batch-run").click();
          assert.match(
            await page.locator("#batch-output").textContent(),
            /错误/,
          );
          await page.locator("[data-tab=convert]").click();
        } else if (slug === "codec") {
          await page.locator("#input").fill("中文🙂");
          await page.locator("#run").click();
          const encoded = await page.locator("#output").inputValue();
          assert.equal(encoded, codec.encodeBase64("中文🙂"));
          await page.locator("#swap").click();
          assert.equal(await page.locator("#output").inputValue(), "中文🙂");
          await page.locator("#input").fill("%%%");
          await page.locator("#run").click();
          assert.equal(await page.locator("#output").inputValue(), "");
          assert.equal(await page.locator("#copy").isDisabled(), true);
          await page.locator("#input").fill(encoded);
          await page.locator("#run").click();
        } else if (slug === "json-tools") {
          await page
            .locator("#input")
            .fill('{"n":900719925474099312345,"a/b":true}');
          await page.locator("[data-action=format]").click();
          assert.match(
            await page.locator("#output").inputValue(),
            /900719925474099312345/,
          );
          await page.locator("[data-view=tree]").click();
          await page.locator("#search").fill("a/b");
          await page.waitForTimeout(250);
          assert.match(await page.locator("#tree").textContent(), /a~1b/);
          await page.locator("#search").fill("");
          await page.locator('#tree .path-copy[title="/a~1b"]').click();
          assert.equal(
            await page.evaluate(() => __calls.copies.at(-1)),
            "/a~1b",
          );
          await page.locator("[data-view=diff]").click();
          await page.locator("#compare").fill('{"n":900719925474099312346}');
          await page.locator("#compare-run").click();
          assert.equal(await page.locator(".diff-row").count(), 2);
          await page.locator("[data-view=text]").click();
        } else if (slug === "password-kit") {
          await page.locator("#count").fill("3");
          await page.locator("#generate-copy").click();
          assert.equal(await page.locator("#results .secret-row").count(), 3);
          assert.equal(
            (await page.evaluate(() => __calls.copies[0])).split("\n").length,
            3,
          );
          await page.locator("#mask").click();
          assert.doesNotMatch(
            await page.locator("#results").textContent(),
            /•/,
          );
          await page.evaluate(() =>
            __emit("enter", { mode: "quick", code: "uuid" }),
          );
          await page.locator("#generate").click();
          assert.match(
            await page.locator("#results .secret").first().textContent(),
            /^[\da-f-]{36}$/,
          );
          await page.locator("[data-kind=password]").click();
          await page.locator("#generate").click();
        }
        await page.screenshot({ path: `/tmp/enest-utility-${slug}-quick.png` });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 2,
          ),
          true,
          slug + " Quick overflow",
        );
        await page.evaluate(() => __emit("mode", "shell"));
        await page.setViewportSize({ width: 1200, height: 760 });
        await page.waitForTimeout(60);
        assert.equal(
          await page.locator("html").getAttribute("data-mode"),
          "shell",
        );
        await page.screenshot({ path: `/tmp/enest-utility-${slug}-shell.png` });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 2,
          ),
          true,
          slug + " desktop overflow",
        );
        await page.evaluate(() => __emit("mode", "quick"));
        assert.equal(
          await page.locator("html").getAttribute("data-mode"),
          "quick",
        );
        assert.deepEqual(errors, [], slug + " browser errors");
        await page.close();
      }
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
