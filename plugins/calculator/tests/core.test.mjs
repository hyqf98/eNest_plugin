import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/calculator/src/js/core.mjs"))
);
const C = { ans: 0, memory: 0, degrees: false, vars: { x: 5, y: 12 } };

test("四则运算优先级与括号", () => {
  assert.equal(core.calculate("1+2*3", C), 7);
  assert.equal(core.calculate("(1+2)*3", C), 9);
  assert.equal(core.calculate("2^10", C), 1024);
  assert.equal(core.calculate("-3^2", C), -9);
  assert.equal(core.calculate("10/4", C), 2.5);
});

test("变量赋值与引用", () => {
  assert.deepEqual(core.parseAssignment("x = 2^10"), { name: "x", expr: "2^10" });
  assert.equal(core.calculate("x*2+y", C), 22);
  assert.equal(core.parseAssignment("e = 3"), null, "e 保留为欧拉数");
  assert.equal(core.parseAssignment("m = 1"), null, "m 保留为内存");
  assert.equal(core.parseAssignment("x == 3"), null, "== 不是赋值");
  assert.equal(core.parseAssignment("1 + 2"), null);
  assert.throws(
    () => core.calculate("z+1", C),
    /未知变量 z/,
  );
});

test("百分号双语义：百分比 vs 取模", () => {
  assert.equal(core.calculate("200*10%", C), 20);
  assert.equal(core.calculate("50%", C), 0.5);
  assert.equal(core.calculate("10%3", C), 1);
  assert.equal(core.calculate("10 % 3", C), 1);
  assert.equal(core.calculate("100+10%", C), 110);
  assert.equal(core.calculate("200-10%", C), 180);
  // 上下文百分比只对裸数字生效；括号组按严格数学语义（÷100）
  assert.equal(core.calculate("100+(2+3)%", C), 100.05);
});

test("常量与函数", () => {
  assert.equal(core.calculate("sqrt(144)+25", C), 37);
  assert.equal(core.calculate("g*2", C), 19.6133);
  assert.ok(Math.abs(core.calculate("π*2", C) - 6.283185307179586) < 1e-12);
  assert.equal(core.calculate("e", C), Math.E);
  assert.equal(core.calculate("max(1,5,3)", C), 5);
  assert.equal(core.calculate("sin(30)", { ...C, degrees: true }).toFixed(10), "0.5000000000");
});

test("错误路径：除零/括号/未知名称", () => {
  assert.throws(() => core.calculate("1/0", C), /不能除以 0/);
  assert.throws(() => core.calculate("(1+2", C), /括号/);
  assert.throws(() => core.calculate("foo(1)", C), /未知/);
  assert.throws(() => core.calculate("1+", C), /不完整/);
  assert.equal(core.calculate("   ", C), null);
});

test("formatNumber：千分位与科学计数切换", () => {
  assert.equal(core.formatNumber(1234567.891, 12, { group: true }), "1,234,567.891");
  assert.equal(core.formatNumber(1234567.891, 12, { group: false }), "1234567.891");
  assert.equal(core.formatNumber(1234567.891, 8, { scientific: true }), "1.2345679e+6");
  assert.equal(core.formatNumber(1024, 12, { group: true }), "1,024");
});
