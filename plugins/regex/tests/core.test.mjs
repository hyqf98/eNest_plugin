import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/regex/src/js/core.mjs"))
);

test("regex core compiles, collects matches with groups and named groups", () => {
  const re = core.compilePattern("(\\d{4})-(\\d{2})-(\\d{2})", "g");
  const matches = core.collectMatches(re, "2026-09-15 与 2026-10-01");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].text, "2026-09-15");
  assert.deepEqual(matches[0].groups.map((g) => g.value), ["2026", "09", "15"]);
  assert.equal(matches[1].index, 13);

  const named = core.collectMatches(
    core.compilePattern("(?<y>\\d{4})/(?<m>\\d{2})", "g"),
    "2026/09",
  );
  assert.deepEqual(named[0].named, { y: "2026", m: "09" });
  assert.deepEqual(
    core.groupRows(named[0]).map((r) => r.ref),
    ["$<y>", "$<m>", "$1", "$2"],
  );

  // 空匹配不死循环，全局匹配重置 lastIndex
  const empty = core.collectMatches(core.compilePattern("x*", "g"), "ab");
  assert.equal(empty.length, 3);
  assert.equal(core.collectMatches(core.compilePattern("a", "g"), "aaa").length, 3);
});

test("regex core parses replacement tokens and renders diff segments", () => {
  const parts = core.parseReplacement("$<y>年$2月$1日 $$ $&");
  assert.deepEqual(parts.filter((p) => p.type === "named"), [{ type: "named", value: "y" }]);
  assert.deepEqual(parts.filter((p) => p.type === "group").map((p) => p.value), [2, 1]);
  const m = core.collectMatches(core.compilePattern("(\\d{4})-(\\d{2})-(\\d{2})", "g"), "2026-09-15")[0];
  // $<y> 在无具名组的正则下替换为空串
  assert.equal(core.applyReplacement(parts, m, "2026-09-15"), "年09月2026日 $ 2026-09-15");
  const nm = core.collectMatches(core.compilePattern("(?<y>\\d{4})-(\\d{2})-(\\d{2})", "g"), "2026-09-15")[0];
  assert.equal(core.applyReplacement(parts, nm, "2026-09-15"), "2026年09月2026日 $ 2026-09-15");
  assert.equal(
    core.replaceAll([m], core.parseReplacement("$1/$2/$3"), "2026-09-15"),
    "2026/09/15",
  );
  // 未参与匹配的可选组替换为空
  const opt = core.collectMatches(core.compilePattern("a(b)?c", "g"), "ac")[0];
  assert.equal(core.replaceAll([opt], core.parseReplacement("[$1]"), "ac"), "[]");

  assert.deepEqual(core.diffSegments("abc", "abc"), [{ type: "same", value: "abc" }]);
  assert.deepEqual(core.diffSegments("axc", "abc"), [
    { type: "same", value: "a" },
    { type: "del", value: "x" },
    { type: "ins", value: "b" },
    { type: "same", value: "c" },
  ]);
});

test("regex default snippets all compile and cover required categories", () => {
  assert.ok(core.DEFAULT_SNIPPETS.length >= 12);
  for (const s of core.DEFAULT_SNIPPETS) {
    assert.doesNotThrow(() => core.compilePattern(s.body, "g"), s.name);
  }
  const phone = core.collectMatches(core.compilePattern("1[3-9]\\d{9}", "g"), "打 13812345678");
  assert.equal(phone[0].text, "13812345678");
  const mail = core.collectMatches(core.compilePattern("[\\w.+-]+@[\\w-]+\\.[\\w.]+", "g"), "a@b.co");
  assert.equal(mail[0].text, "a@b.co");
});

test("regex matches carry line numbers for list positioning", () => {
  const re = core.compilePattern("\\d+", "g");
  const text = "第一行 1\n第二行 22\n第三行 333";
  const matches = core.collectMatches(re, text);
  assert.deepEqual(matches.map((m) => m.line), [1, 2, 3]);
  assert.equal(core.lineOfIndex(text, 0), 1);
  assert.equal(core.lineOfIndex(text, text.indexOf("333")), 3);
  assert.equal(core.lineOfIndex("", 0), 1);
});

test("template library groups by category and every template compiles", () => {
  const groups = core.templateGroups();
  assert.ok(groups.length >= 3);
  for (const group of groups) {
    assert.ok(group.name && group.items.length > 0, group.name);
    for (const tpl of group.items) {
      assert.doesNotThrow(() => core.compilePattern(tpl.body, "g"), tpl.name);
      assert.ok(typeof tpl.sample === "string" && tpl.sample.length > 0, `${tpl.name} 缺示例`);
    }
  }
  const categories = groups.map((g) => g.name);
  for (const required of ["常用", "网络", "数字", "文本"]) assert.ok(categories.includes(required), required);
  // 邮箱模板对其示例至少命中 1 处
  const mail = groups.flatMap((g) => g.items).find((t) => t.name === "邮箱地址");
  const hits = core.collectMatches(core.compilePattern(mail.body, "g"), mail.sample);
  assert.ok(hits.length >= 1);
});

test("flag definitions expose detail explanations", () => {
  assert.equal(core.FLAG_DEFS.length, 6);
  for (const f of core.FLAG_DEFS) assert.ok(f.key && f.label && f.detail, f.key);
});
