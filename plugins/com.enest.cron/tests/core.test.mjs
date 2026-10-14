import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cron = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.cron/src/js/core.mjs"))
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
  // 2 月没有 30 日：一年扫描不到命中，应抛错而不是死循环
  assert.throws(() => cron.nextFire(cron.parseExpression("0 3 30 2 *"), base, 1), /一年内/);
});

test("cron describes schedules in Chinese", () => {
  assert.equal(cron.describe(cron.parseExpression("*/5 * * * *")), "每 5 分钟");
  assert.equal(cron.describe(cron.parseExpression("0 * * * *")), "每小时");
  assert.match(cron.describe(cron.parseExpression("30 8 * * 1")), /周一/);
  assert.match(cron.describe(cron.parseExpression("30 8 * * 1")), /08:30/);
  assert.match(cron.describe(cron.parseExpression("0 3 * * *")), /03:00/);
  assert.match(cron.describe(cron.parseExpression("0 0 1 * *")), /每月 1 日/);
});

test("cron presets ship at least 10 entries and all compile", () => {
  assert.ok(cron.PRESETS.length >= 10);
  for (const p of cron.PRESETS) assert.doesNotThrow(() => cron.parseExpression(p.expr), p.name);
  for (const [key, chips] of Object.entries(cron.FIELD_CHIPS)) {
    const domain = cron.DOMAINS.find((d) => d.key === key);
    for (const chip of chips) assert.doesNotThrow(() => cron.parseField(chip.value, domain), chip.value);
  }
});
