import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.json-tools/src/js/core.mjs"))
);

const unescape = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const nested = `{
  "name": "a<b>&\\"q\\"",
  "list": [
    1,
    -2.5e10,
    true
  ],
  "nested": {
    "k": null
  },
  "s": "}{[],:"
}`;

test("highlightJsonHtml: key/str/num/lit 分类与 HTML 转义", () => {
  const html = core.highlightJsonHtml(nested);
  assert.match(html, /<span class="tk-key">&quot;name&quot;<\/span>/);
  assert.match(html, /<span class="tk-str">&quot;a&lt;b&gt;&amp;\\&quot;q\\&quot;&quot;<\/span>/);
  assert.match(html, /<span class="tk-num">-2\.5e10<\/span>/);
  assert.match(html, /<span class="tk-lit">true<\/span>/);
  assert.match(html, /<span class="tk-lit">null<\/span>/);
  // 字符串值里含结构字符不会被当 key/punct
  assert.match(html, /<span class="tk-str">&quot;}{\[\],:&quot;<\/span>/);
});

test("highlightJsonHtml: 去掉标签与反转义后与原文逐字一致", () => {
  assert.equal(unescape(core.highlightJsonHtml(nested)), nested);
});

test("highlightJsonHtml: 超限返回 null 供调用方降级", () => {
  assert.equal(core.highlightJsonHtml("[".concat("1,".repeat(200001), "1]")), null);
});

test("computeJsonFolds: 嵌套块行区间与深度", () => {
  const folds = core.computeJsonFolds(nested);
  // list 块 2-6 行（depth 1）、nested 块 7-9 行（depth 1）、根块 0-11 行（depth 0）
  const list = folds.find((f) => f.start === 2);
  assert.equal(list.end, 6);
  assert.equal(list.depth, 1);
  const nestedFold = folds.find((f) => f.start === 7);
  assert.equal(nestedFold.end, 9);
  const rootFold = folds.find((f) => f.start === 0);
  assert.equal(rootFold.end, 11);
  assert.equal(rootFold.depth, 0);
});

test("computeJsonFolds: 单行对象不产生折叠；同一起始行可有多个块", () => {
  assert.deepEqual(core.computeJsonFolds('{"a":1}'), []);
  // 根 { 在第 0 行、"list": [ 在第 1 行各开一个跨行块
  const text = '{\n  "list": [\n    1\n  ]\n}';
  const starts = core.computeJsonFolds(text).map((f) => f.start).sort();
  assert.deepEqual(starts, [0, 1]);
});

test("computeJsonFolds: 字符串内的括号不参与配对；超限返回 null", () => {
  const tricky = '{\n  "a": "(((]]"\n}';
  const folds = core.computeJsonFolds(tricky);
  assert.equal(folds.length, 1);
  assert.equal(folds[0].start, 0);
  assert.equal(folds[0].end, 2);
  assert.equal(core.computeJsonFolds("[".concat("1,".repeat(200001), "1]")), null);
});
