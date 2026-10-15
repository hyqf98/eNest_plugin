import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.unit-convert/src/js/core.js"))
);

test("温度（非线性单位）换算正确", () => {
  assert.deepEqual(core.convertAll("temp", "C", 100), { C: 100, F: 212, K: 373.15 });
  assert.deepEqual(core.convertAll("temp", "F", 32), { C: 0, F: 32, K: 273.15 });
  assert.deepEqual(core.convertAll("temp", "K", 0), { C: -273.15, F: -459.67, K: 0 });
  // −40 是摄氏/华氏交点
  assert.equal(core.convertAll("temp", "F", -40).C, -40);
  assert.equal(core.convertAll("temp", "C", 37).F, 98.6);
});

test("线性类目：长度/质量/数据量", () => {
  assert.equal(core.convertAll("length", "mi", 1).km, 1.609344);
  assert.equal(core.convertAll("mass", "lb", 1).g, 453.59237);
  assert.equal(core.convertAll("mass", "jin", 1).kg, 0.5);
  assert.equal(core.convertAll("data", "GB", 1).MB, 1024);
  assert.equal(core.convertAll("data", "GB", 1).bit, 8 * 1024 ** 3);
});

test("新增类目：时间/压力/能量", () => {
  assert.equal(core.convertAll("time", "d", 1).h, 24);
  assert.equal(core.convertAll("time", "wk", 1).d, 7);
  const atm = core.convertAll("pressure", "atm", 1);
  assert.ok(Math.abs(atm.mmHg - 760) < 0.001, "1 atm ≈ 760 mmHg");
  assert.ok(Math.abs(atm.kPa - 101.325) < 1e-9);
  const kwh = core.convertAll("energy", "kWh", 1);
  assert.ok(Math.abs(kwh.kcal - 860.420650096) < 1e-6, "1 kWh ≈ 860.42 kcal");
  assert.equal(core.convertAll("energy", "kWh", 1).Wh, 1000);
});

test("精度参数生效且双向一致", () => {
  assert.equal(core.convertAll("length", "in", 1, { precision: 6 }).cm, 2.54);
  const full = core.convertAll("length", "m", 1);
  assert.ok(full.ft > 3.2808 && full.ft < 3.2809);
  // 双向：km → mi → km 回到原值
  const toMi = core.convertAll("length", "km", 5).mi;
  assert.ok(Math.abs(core.convertAll("length", "mi", toMi).km - 5) < 1e-9);
});

test("formatNumber：千分位与科学计数", () => {
  assert.equal(core.formatNumber(1234567.891), "1,234,567.891");
  assert.equal(core.formatNumber(6.02214076e23, { scientific: true }), "6.022141e+23");
  assert.equal(core.formatNumber(NaN), "—");
  assert.equal(core.formatNumber(-0), "0");
  assert.equal(core.formatNumber(0.1 + 0.2), "0.3");
});

test("formulaText：温度给公式，线性类目给系数", () => {
  assert.equal(core.formulaText("temp", "F", "C"), "°C = (°F − 32) × 5/9");
  assert.equal(core.formulaText("temp", "K", "C"), "°C = K − 273.15");
  assert.match(core.formulaText("length", "km", "mi"), /^1 千米 = 0\.62\d* 英里$/);
  assert.equal(core.formulaText("length", "m", "m"), "");
});

test("parseInput 容忍千分位与全角数字", () => {
  assert.equal(core.parseInput("1,234.5"), 1234.5);
  assert.equal(core.parseInput("１２３"), 123);
  assert.ok(Number.isNaN(core.parseInput("abc")));
});

test("人民币大写票据规则", () => {
  assert.equal(core.toRmbUpper(1024.5), "壹仟零贰拾肆元伍角整");
  assert.equal(core.toRmbUpper(0), "零元整");
  assert.equal(core.toRmbUpper(1000000), "壹佰万元整");
  assert.equal(core.toChineseNumber(1024), "一千零二十四");
});
