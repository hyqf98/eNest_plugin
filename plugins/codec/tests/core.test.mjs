import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/codec/src/js/core.mjs"))
);

test("base64 / base64url round-trip and strict errors", () => {
  assert.equal(core.encodeBase64("hello"), "aGVsbG8=");
  assert.equal(core.decodeBase64("aGVsbG8="), "hello");
  assert.equal(core.encodeBase64("中文", true), "5Lit5paH");
  assert.equal(core.decodeBase64("5Lit5paH", true), "中文");
  // URL 安全字母表：+ / 被替换，填充被剥离
  const raw = core.encodeBase64("subjects?_~");
  assert.equal(core.decodeBase64(raw.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), true), "subjects?_~");
  assert.throws(() => core.decodeBase64("a-b!", false), /Base64/);
  assert.throws(() => core.decodeBase64("a-b!", true), /Base64URL/);
  assert.throws(() => core.decodeBase64("aGVsb", true), /Base64 长度不正确/);
  // 严格 UTF-8：非法序列报错（TextDecoder fatal），宽松模式输出替换符
  const badUtf8 = Buffer.from([0x61, 0xff, 0x62]).toString("base64");
  assert.throws(() => core.decodeBase64(badUtf8, false, true), /utf-8/);
  assert.equal(core.decodeBase64(badUtf8, false, false).includes("\uFFFD"), true);
});

test("convert covers all text modes", () => {
  assert.equal(core.convert("a=b&c", "url", "encode"), "a%3Db%26c");
  assert.equal(core.convert("a%3Db%26c", "url", "decode"), "a=b&c");
  assert.equal(core.convert("ab", "hex", "encode"), "6162");
  assert.equal(core.convert("6162", "hex", "decode"), "ab");
  assert.equal(core.convert("中", "unicode", "encode"), "\\u4e2d");
  assert.equal(core.convert("\\u4e2d", "unicode", "decode"), "中");
  assert.equal(core.convert("<a&b>", "html", "encode"), "&lt;a&amp;b&gt;");
  assert.equal(core.convert("&lt;a&amp;b&gt;&#x4e2d;", "html", "decode"), "<a&b>中");
  assert.equal(
    core.convert("hello", "dataurl", "encode"),
    "data:text/plain;charset=utf-8," + encodeURIComponent("hello"),
  );
  const info = core.parseDataUrl(core.convert("hello", "dataurl", "encode"));
  assert.equal(info.mime, "text/plain");
  assert.equal(info.text, "hello");
});

test("jwt / query modes and error surfacing", () => {
  const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = `${b64url('{"alg":"HS256"}')}.${b64url('{"sub":"a"}')}.sig`;
  assert.match(core.convert(token, "jwt", "decode"), /Header/);
  assert.match(core.convert(token, "jwt", "decode"), /签名未验证/);
  assert.throws(() => core.convert("a.b", "jwt", "decode"), /三个/);
  assert.equal(core.convert("https://x.dev/?b=2&a=1", "query", "decode"), JSON.stringify([["b", "2"], ["a", "1"]], null, 2));
  assert.equal(core.convert('[["k","v"],["k","2"]]', "query", "encode"), "k=v&k=2");
  assert.throws(() => core.convert('{"k":"v"}', "query", "encode"), /\[\["键","值"\]\] 数组/);
  assert.throws(() => core.convert("616", "hex", "decode"), /偶数/);
});

test("locateError pins first invalid character", () => {
  const bad = "aGVsbG8=*";
  const hit = core.locateError(bad, "base64", "decode", { strictUtf8: true });
  assert.ok(hit);
  assert.equal(hit.index, bad.indexOf("*"));
  assert.match(hit.message, /Base64/);
  const hexBad = "6162zz";
  const hexHit = core.locateError(hexBad, "hex", "decode", { strictUtf8: true });
  assert.equal(hexHit.index, 4);
  assert.equal(core.locateError("aGVsbG8=", "base64", "decode", {}), null);
});

test("convertLines isolates per-line failures", () => {
  const rows = core.convertLines("aGVsbG8=\nnot*ok\n6162", "base64", "decode", { strictUtf8: true });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].value, "hello");
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].value, /Base64/);
  assert.equal(rows[2].line, 3);
  assert.equal(core.convertLines("a\nb\nc", "url", "encode").map((r) => r.value).join("|"), "a|b|c");
});

test("dataurl helpers: encode bytes, parse, mime mapping", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const url = core.encodeDataUrl(bytes, "image/png");
  assert.equal(url, "data:image/png;base64,iVBORw==");
  const parsed = core.parseDataUrl(url);
  assert.equal(parsed.base64, true);
  assert.equal(parsed.size, 4);
  assert.equal(parsed.mime, "image/png");
  assert.equal(core.mimeToExt("image/png"), "png");
  assert.equal(core.mimeToExt("font/woff2"), "woff2");
  assert.equal(core.mimeToExt("weird"), "bin");
  assert.equal(core.guessMime("shot.png"), "image/png");
  assert.equal(core.guessMime("no-extension"), "application/octet-stream");
  assert.throws(() => core.parseDataUrl("http://x"), /Data URL/);
});

test("history helpers normalize, dedupe and cap", () => {
  const now = Date.now();
  const seed = [
    { text: "a", mode: "base64", direction: "encode", at: now - 2000 },
    { text: "b", mode: "url", direction: "decode", at: now - 1000 },
    // 脏数据：未知模式 / 非法方向 / 缺时间戳 / 非对象
    { text: "c", mode: "nope", direction: "encode", at: now },
    { text: "d", mode: "hex", direction: "sideways", at: now },
    { text: "e", mode: "hex", direction: "encode" },
    "junk",
    null,
  ];
  assert.deepEqual(core.normalizeHistory(seed).map((r) => r.text), ["b", "a"]);
  // 去重 + 最新在前 + 上限裁剪
  const many = Array.from({ length: 30 }, (_, i) => ({ text: "t" + i, mode: "hex", direction: "encode", at: now + i }));
  const pushed = core.pushHistory(many, { text: "fresh", mode: "base64", direction: "encode", at: now + 999 });
  assert.equal(pushed.length, 24);
  assert.equal(pushed[0].text, "fresh");
  assert.deepEqual(core.normalizeHistory("legacy-string-or-null"), []);
  assert.deepEqual(core.normalizeHistory(null), []);
  assert.equal(core.pushHistory([], { text: "x", mode: "base64", direction: "encode", at: 1 })[0].text, "x");
});

test("formatHistoryTime renders relative then absolute", () => {
  const now = Date.now();
  assert.equal(core.formatHistoryTime(now - 10_000, now), "刚刚");
  assert.equal(core.formatHistoryTime(now - 120_000, now), "2 分钟前");
  assert.equal(core.formatHistoryTime(now - 7_200_000, now), "2 小时前");
  assert.match(core.formatHistoryTime(now - 90 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/);
});
