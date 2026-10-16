import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const extra = await import(
  pathToFileURL(resolve(root, "plugins/json-tools/src/js/extra.mjs"))
);
const core = await import(
  pathToFileURL(resolve(root, "plugins/json-tools/src/js/core.mjs"))
);

const sample = {
  users: [
    { id: 1, name: "Alice", tags: ["admin"], active: true },
    { id: 2, name: "Bob", tags: [], active: false },
  ],
  meta: { version: "1.2", count: 2 },
  note: null,
};
const ast = core.parseJson(JSON.stringify(sample)).root;

/* ── 路径查询 ── */
test("query resolves child chains, indexes and wildcards", () => {
  const hit = extra.queryJson(ast, "$.meta.version");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].node.kind, "string");
  assert.equal(hit[0].node.value, "1.2");
  assert.equal(hit[0].path, "/meta/version");

  const first = extra.queryJson(ast, "$.users[0].name");
  assert.equal(first[0].node.value, "Alice");

  const last = extra.queryJson(ast, "$.users[-1].name");
  assert.equal(last[0].node.value, "Bob");

  const names = extra.queryJson(ast, "$.users[*].name");
  assert.deepEqual(names.map((m) => m.node.value), ["Alice", "Bob"]);

  const users = extra.queryJson(ast, "$.users[*]");
  assert.equal(users.length, 2);
  assert.ok(users[0].node.kind === "object");

  // 无 $ 前缀与括号键写法等价
  const bracket = extra.queryJson(ast, "$['meta']['version']");
  assert.equal(bracket[0].node.value, "1.2");

  // 键含特殊字符按 JSON Pointer 转义
  const weird = core.parseJson('{"a/b": {"c~d": 7}}').root;
  const found = extra.queryJson(weird, "$.a/b.c~d");
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "/a~1b/c~0d");
  assert.equal(found[0].node.raw, "7");
});

test("query deep search and error reporting", () => {
  const ids = extra.queryJson(ast, "$..id");
  assert.deepEqual(ids.map((m) => m.node.raw), ["1", "2"]);

  assert.throws(() => extra.queryJson(ast, ""), /查询为空/);
  assert.throws(() => extra.queryJson(ast, "$.users[") / /未闭合/);
  assert.throws(() => extra.queryJson(ast, "$.."), /键名/);
  assert.throws(() => extra.queryJson(ast, "$.users[@]"), /无法识别/);
  // 不存在的路径返回空数组
  assert.equal(extra.queryJson(ast, "$.missing.deep").length, 0);
});

/* ── 统计 ── */
test("jsonStats counts types, keys and array sizes", () => {
  const stats = extra.jsonStats(ast);
  assert.equal(stats.counts.object, 4); // root + 2 users + meta
  assert.equal(stats.counts.array, 3); // users + 2 个 tags
  assert.equal(stats.counts.string, 4); // Alice Bob admin version
  assert.equal(stats.counts.number, 3); // id 1、id 2、meta.count
  assert.equal(stats.counts.boolean, 2);
  assert.equal(stats.counts.null, 1);
  assert.equal(stats.maxArrayLength, 2);
  assert.equal(stats.distinctKeys, 9);
  assert.equal(stats.visited, 17);
  const top = stats.topKeys.map(([key]) => key);
  assert.ok(top.includes("id") && top.includes("name"));
});

/* ── TypeScript 生成 ── */
test("toTypeScript expands nested objects into named interfaces", () => {
  const ts = extra.toTypeScript(ast, { rootName: "Api" });
  assert.match(ts, /export interface (\w+) \{/);
  assert.match(ts, /id: number;/);
  assert.match(ts, /name: string;/);
  assert.match(ts, /active: boolean;/);
  assert.match(ts, /note: null;/);
  assert.match(ts, /users:/);
  // 数组元素类型：tags 空数组 → unknown[]
  assert.match(ts, /tags: unknown\[\];/);
  // meta.version 是 string
  assert.match(ts, /version: string;/);
});

test("toTypeScript reuses identical object shapes and unions array elements", () => {
  const src = {
    items: [
      { kind: "a", size: 1 },
      { kind: "b", size: 2 },
    ],
    mixed: [{ v: 1 }, { v: "x" }],
  };
  const ts = extra.toTypeScript(core.parseJson(JSON.stringify(src)).root, { rootName: "Doc" });
  // 相同结构的两个对象应共用一个 interface（只声明一次 size/kind 的 interface）
  const kindDecls = ts.match(/kind: string;/g) || [];
  assert.equal(kindDecls.length, 1);
  // 混合数组：元素为两个不同 interface 的联合
  assert.match(ts, /v: number;/);
  assert.match(ts, /v: string;/);
  assert.match(ts, /\(/);
});

test("toTypeScript handles scalar roots, empty arrays and empty objects", () => {
  // 全同型数组压缩为 number[]
  assert.equal(extra.toTypeScript(core.parseJson("[1,2,3]").root, { rootName: "Root" }), "export type Root = number[];\n");
  assert.match(extra.toTypeScript(core.parseJson("[]").root), /unknown\[\]/);
  assert.match(extra.toTypeScript(core.parseJson("{}").root), /\[key: string\]: unknown;/);
  assert.match(extra.toTypeScript(core.parseJson('"hi"').root), /export type \w+ = string;/);
});

test("toTypeScript quotes non-identifier keys", () => {
  const ts = extra.toTypeScript(core.parseJson('{"weird-key": 1, "2nd": true}').root);
  assert.match(ts, /"weird-key": number;/);
  assert.match(ts, /"2nd": boolean;/);
});
