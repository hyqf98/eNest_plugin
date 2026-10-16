import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cron = await import(
  pathToFileURL(resolve(root, "plugins/cron/src/js/core.mjs"))
);

test("cron parses 5-field and 6-field expressions with lists, ranges, steps and names", () => {
  const five = cron.parseExpression("*/5 * * * *");
  assert.equal(five.sets[1].size, 12);
  assert.ok(five.sets[1].has(0) && five.sets[1].has(55));

  const list = cron.parseExpression("30 8,20 * * 1-5");
  assert.deepEqual([...list.sets[1]], [30]);
  assert.deepEqual([...list.sets[2]].sort((a, b) => a - b), [8, 20]);
  assert.deepEqual([...list.sets[5]].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  const six = cron.parseExpression("*/10 30 8 * * 1-5", { withSeconds: true });
  assert.equal(six.withSeconds, true);
  assert.equal(six.sets[0].size, 6);
  assert.throws(() => cron.parseExpression("* * * *"), /期望/);
  assert.throws(() => cron.parseExpression("61 * * * *"), /范围/);
  assert.throws(() => cron.parseExpression("a * * * *"), /无法识别/);
});

test("cron rejects Quartz-only L W # ? characters with domain-scoped messages", () => {
  assert.throws(() => cron.parseExpression("0 0 L * *"), /不支持 Quartz 的 L/);
  assert.throws(() => cron.parseExpression("0 0 15W * *"), /不支持 Quartz 的 L \/ W/);
  assert.throws(() => cron.parseExpression("0 0 * * 1#2"), /不支持 Quartz 的 #/);
  assert.throws(() => cron.parseExpression("0 0 ? * 1"), /不支持 \?/);
});

test("expression errors pinpoint the offending field", () => {
  // 第 2 个域（时）非法：61
  const err = (() => {
    try {
      cron.parseExpression("0 61 * * *");
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.match(err.message, /第 2 个域「时」/);
  // 6 域定位含秒：第 1 个域「秒」
  const err6 = (() => {
    try {
      cron.parseExpression("90 0 9 * * *", { withSeconds: true });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.match(err6.message, /第 1 个域「秒」/);
});

test("cron resolves macros and formats schedules back", () => {
  assert.equal(cron.parseExpression("@daily").raw, "0 0 * * *");
  assert.equal(cron.parseCrontabLine("@HOURLY"), "0 * * * *");
  assert.equal(cron.parseCrontabLine("# 注释"), null);
  assert.equal(cron.parseCrontabLine("*/5 * * * *"), "*/5 * * * *");
  assert.throws(() => cron.parseCrontabLine("@nope"), /未知宏/);
  const s = cron.parseExpression("0 9 * * 1-5");
  assert.equal(cron.formatSchedule(s), "0 9 * * 1-5");
  assert.equal(cron.formatSchedule(cron.parseExpression("*/15 * * * *")), "*/15 * * * *");
  assert.equal(cron.formatSchedule(cron.parseExpression("0 12,18 * * *")), "0 12,18 * * *");
  assert.equal(
    cron.formatSchedule(cron.parseExpression("0 0 1 1,4,7,10 *")),
    // 1,4,7,10 从 1 起等差延伸封顶，规范压缩为每季度
    "0 0 1 */3 *",
  );
  assert.equal(
    cron.formatSchedule(cron.parseExpression("*/10 30 8 * * 1-5", { withSeconds: true })),
    "*/10 30 8 * * 1-5",
  );
});

test("cron computes next fire times deterministically in local time", () => {
  // 2026-10-13 是周二。基准 08:00，每 5 分钟 → 下一批全部 :05 的倍数
  const base = new Date(2026, 9, 13, 8, 0, 0, 0);
  const fires = cron.nextFire(cron.parseExpression("*/5 * * * *"), base, 5);
  assert.deepEqual(
    fires.map((d) => `${d.getHours()}:${d.getMinutes()}`),
    ["8:5", "8:10", "8:15", "8:20", "8:25"],
  );

  const weekly = cron.nextFire(cron.parseExpression("30 8 * * 1"), base, 2);
  assert.equal(weekly[0].getDay(), 1);
  assert.deepEqual(
    weekly.map((d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes()}`),
    ["10/19 8:30", "10/26 8:30"],
  );

  const daily3 = cron.nextFire(cron.parseExpression("0 3 * * *"), base, 1);
  assert.deepEqual([daily3[0].getHours(), daily3[0].getMinutes()], [3, 0]);
  assert.equal(daily3[0].getDate(), 14); // 今天 3 点已过

  const monthly = cron.nextFire(cron.parseExpression("0 0 1 * *"), base, 1);
  assert.deepEqual([monthly[0].getMonth() + 1, monthly[0].getDate()], [11, 1]);

  const seconds = cron.nextFire(cron.parseExpression("*/30 * * * * *", { withSeconds: true }), base, 3);
  assert.deepEqual(
    seconds.map((d) => d.getSeconds()),
    [30, 0, 30],
  );

  const tuesdays = cron.nextFire(cron.parseExpression("0 3 * * 2"), base, 2);
  assert.equal(tuesdays[0].getDay(), 2);
  assert.deepEqual(
    tuesdays.map((d) => `${d.getMonth() + 1}/${d.getDate()} 3:0`),
    ["10/20 3:0", "10/27 3:0"],
  );
  // 2 月没有 30 日：扫描不到命中，应抛错而不是死循环
  assert.throws(() => cron.nextFire(cron.parseExpression("0 3 30 2 *"), base, 1), /没有足够的匹配执行时间/);
});

test("cron nextFire handles leap-year Feb 29 and month-length boundaries", () => {
  // 2027-02-27 基准，每年 2 月 29 日 → 下一次命中应为 2028-02-29（闰年）
  const beforeLeap = new Date(2027, 1, 27, 12, 0, 0, 0);
  const leap = cron.nextFire(cron.parseExpression("0 0 29 2 *"), beforeLeap, 2);
  assert.deepEqual(
    leap.map((d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`),
    ["2028-2-29", "2032-2-29"],
  );

  // 2028 年（闰年）1 月 30 日看 2 月 29 日 → 当年即命中
  const inLeap = new Date(2028, 0, 30, 0, 0, 0, 0);
  const sameYear = cron.nextFire(cron.parseExpression("0 0 29 2 *"), inLeap, 1);
  assert.equal(`${sameYear[0].getFullYear()}-${sameYear[0].getMonth() + 1}-${sameYear[0].getDate()}`, "2028-2-29");

  // 月末 31→1（跳过 2 月）：每月 31 日，基准 2026-01-31 10:00 当天命中 → 之后 3-31、5-31（4 月只有 30 天）
  const jan31 = new Date(2026, 0, 31, 10, 0, 0, 0);
  const monthEnd = cron.nextFire(cron.parseExpression("0 12 31 * *"), jan31, 3);
  assert.deepEqual(
    monthEnd.map((d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`),
    ["2026-1-31", "2026-3-31", "2026-5-31"],
  );

  // 4 月只有 30 天：每月 30 日在 3 月 30 日之后应命中 4 月 30 日
  const mar30 = new Date(2026, 2, 30, 9, 0, 0, 0);
  const apr30 = cron.nextFire(cron.parseExpression("0 8 30 * *"), mar30, 1);
  assert.deepEqual([apr30[0].getMonth() + 1, apr30[0].getDate()], [4, 30]);
});

test("cron nextFire crosses year boundaries and minute-mode fires land on whole minutes", () => {
  // 跨年：每年 1 月 1 日，从 2026-12-02 起算 → 2027-01-01
  const dec = new Date(2026, 11, 2, 0, 0, 0, 0);
  const newYear = cron.nextFire(cron.parseExpression("0 0 1 1 *"), dec, 1);
  assert.deepEqual(
    [newYear[0].getFullYear(), newYear[0].getMonth() + 1, newYear[0].getDate()],
    [2027, 1, 1],
  );

  // 12 月 31 日 23:30 起每小时 → 23 点档已过，下一命中跨年到 1/1 00:00
  const nye = new Date(2026, 11, 31, 23, 30, 0, 0);
  const hourly = cron.nextFire(cron.parseExpression("0 * * * *"), nye, 3);
  assert.deepEqual(
    hourly.map((d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes()}`),
    ["1/1 0:0", "1/1 1:0", "1/1 2:0"],
  );

  // 分钟模式的结果秒恒为 0
  const base = new Date(2026, 9, 13, 8, 0, 30, 0);
  const fires = cron.nextFire(cron.parseExpression("*/7 * * * *"), base, 4);
  for (const d of fires) assert.equal(d.getSeconds(), 0);
  assert.deepEqual(fires.map((d) => d.getMinutes()), [7, 14, 21, 28]);

  // 秒级模式：从 08:00:30 起每 20 秒 → 40, 0(下一分钟), 20
  const sec = cron.nextFire(cron.parseExpression("*/20 * * * * *", { withSeconds: true }), base, 3);
  assert.deepEqual(sec.map((d) => `${d.getMinutes()}:${d.getSeconds()}`), ["0:40", "1:0", "1:20"]);
});

test("cron describes schedules in Chinese", () => {
  assert.equal(cron.describe(cron.parseExpression("*/5 * * * *")), "每 5 分钟");
  assert.equal(cron.describe(cron.parseExpression("0 * * * *")), "每小时");
  assert.match(cron.describe(cron.parseExpression("30 8 * * 1")), /周一/);
  assert.match(cron.describe(cron.parseExpression("30 8 * * 1")), /08:30/);
  assert.match(cron.describe(cron.parseExpression("0 3 * * *")), /凌晨/);
  assert.match(cron.describe(cron.parseExpression("0 3 * * *")), /03:00/);
  assert.match(cron.describe(cron.parseExpression("0 0 1 * *")), /每月 1 日/);
});

test("describe compresses weekday ranges and marks day/week OR semantics", () => {
  // 工作日压缩为「周一至周五」
  assert.match(cron.describe(cron.parseExpression("0 9 * * 1-5")), /周一至周五/);
  // 周末
  assert.match(cron.describe(cron.parseExpression("0 10 * * 0,6")), /周末/);
  // 日与周同时受限：或
  assert.match(cron.describe(cron.parseExpression("0 9 1 * 1")), /每月 1 日 或 每周一/);
  // 时段词：22 点 → 晚上
  assert.match(cron.describe(cron.parseExpression("0 22 * * *")), /晚上/);
  // 12 点 → 中午
  assert.match(cron.describe(cron.parseExpression("0 12 * * *")), /中午/);
  // 每天 + 具体时刻
  assert.match(cron.describe(cron.parseExpression("30 8,20 * * *")), /每天/);
});

test("cron presets ship at least 10 entries and all compile", () => {
  assert.ok(cron.PRESETS.length >= 10);
  for (const p of cron.PRESETS) assert.doesNotThrow(() => cron.parseExpression(p.expr), p.name);
  for (const [key, chips] of Object.entries(cron.FIELD_CHIPS)) {
    const domain = cron.DOMAINS.find((d) => d.key === key);
    for (const chip of chips) assert.doesNotThrow(() => cron.parseField(chip.value, domain), chip.value);
  }
});
