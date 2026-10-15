import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.diff/src/js/core.mjs"))
);

test("diff computes LCS line script and counts", () => {
  const a = "alpha\nbravo\ncharlie\ndelta";
  const b = "alpha\nbravo\ncharly\ndelta\necho";
  const script = core.diffLines(a, b);
  assert.equal(script.filter((s) => s.type === "same").length, 3);
  const counts = core.countChanges(script);
  assert.deepEqual(counts, { dels: 1, adds: 2 });
  assert.equal(script.find((s) => s.type === "del").aIndex, 2);
  const adds = script.filter((s) => s.type === "add");
  assert.deepEqual(adds.map((s) => s.bIndex).sort((x, y) => x - y), [2, 4]);
});

test("diff options ignore whitespace and case", () => {
  const a = "Hello World\n  same line  \nX";
  const b = "hello world\nsame line\ny";
  assert.equal(core.countChanges(core.diffLines(a, b)).dels, 3);
  const script = core.diffLines(a, b, { ignoreWhitespace: true, ignoreCase: true });
  assert.deepEqual(core.countChanges(script), { dels: 1, adds: 1 });
});

test("diff ignoreBlank skips blank lines and preserves original numbering", () => {
  const a = "one\n\n two\nthree";
  const b = "one\ntwo\nthree";
  const strict = core.countChanges(core.diffLines(a, b));
  assert.ok(strict.dels + strict.adds > 0);
  const script = core.diffLines(a, b, { ignoreWhitespace: true, ignoreBlank: true });
  assert.deepEqual(core.countChanges(script), { dels: 0, adds: 0 });
  // 原始行号保留：same 指向剔除空行前的真实下标（"three" 在 a 中是第 4 行，0 基 3）
  const three = script.find((s) => s.type === "same" && s.aIndex === 3);
  assert.equal(three.bIndex, 2);
});

test("diff chars segments and hunk pairing", () => {
  assert.deepEqual(core.diffChars("abc", "abc"), [{ value: "abc", kind: "same" }]);
  const segs = core.diffChars("axc", "abc");
  assert.deepEqual(
    segs.map((s) => [s.kind, s.value]),
    [
      ["same", "a"],
      ["del", "x"],
      ["ins", "b"],
      ["same", "c"],
    ],
  );
  const script = core.diffLines("a\nx\ny\nb", "a\np\nq\nb");
  const hunks = core.pairHunks(script);
  assert.deepEqual(
    hunks.map((h) => h.type),
    ["same", "change", "same"],
  );
  assert.equal(hunks[1].dels.length, 2);
  assert.equal(hunks[1].adds.length, 2);
});

test("unified diff output is copy-pastable", () => {
  const out = core.unifiedDiff("a\nb\nc", "a\nB\nc");
  assert.match(out, /^--- a\n\+\+\+ b\n/);
  assert.match(out, /@@ -1,3 \+1,3 @@/);
  assert.match(out, /\n-b\n\+B\n/);
  assert.equal(core.unifiedDiff("same", "same"), "");
  // 多处修改在 context=3 时合并进同一 hunk
  const multi = core.unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\n2\n3\n4\nfive\n6\n7\n8\nnine\n10");
  assert.match(multi, /-5\n\+five/);
  assert.match(multi, /-9\n\+nine/);
  assert.equal(multi.split("@@").length - 1, 2); // ---/+++ 头之外的 hunk 头 1 个
  // 相距遥远的修改拆成两个 hunk
  const far = core.unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\nplus");
  const hunkCount = far.split("\n").filter((l) => l.startsWith("@@")).length;
  assert.equal(hunkCount, 2);
});

test("unified diff respects ignoreBlank", () => {
  const a = "x\n\ny";
  const b = "x\ny";
  assert.equal(core.unifiedDiff(a, b, { options: { ignoreBlank: true } }), "");
  assert.notEqual(core.unifiedDiff(a, b), "");
});

test("hex dump formats offsets and printable column", () => {
  const dump = core.hexDump("ABC", 16);
  assert.match(dump, /^00000000  41 42 43/);
  assert.match(dump, /\|ABC\|$/);
  const bin = core.hexDump("A\n\x00é");
  // 换行 / NUL / é 的两个 UTF-8 字节都显示为 ·（共 5 字节）
  assert.match(bin, /\|A\xB7{4}\|/);
  const lines = core.hexDump("x".repeat(33), 16).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^00000020/);
});

test("json normalization sorts keys recursively and keeps array order", () => {
  const a = '{"b":1,"a":{"d":2,"c":[3,1]}}';
  const b = '{\n  "a": { "c": [3, 1], "d": 2 },\n  "b": 1\n}';
  const pair = core.normalizeJsonPair(a, b);
  assert.ok(pair);
  assert.equal(pair.a, pair.b); // 键序与空白差异被规范化抹平
  const reordered = core.normalizeJsonPair(a, '{"b":1,"a":{"d":2,"c":[1,3]}}');
  assert.ok(reordered);
  assert.notEqual(reordered.a, reordered.b); // 数组顺序保持，仍视为差异
});

test("json normalization degrades to plain text on invalid json", () => {
  const pair = core.normalizeJsonPair('{"a":1}', "not json at all");
  assert.equal(pair, null);
});
