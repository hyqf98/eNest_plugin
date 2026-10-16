import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const core = await import(
  pathToFileURL(resolve(root, "plugins/timestamp/src/js/core.mjs"))
);

test("parseTime 自动识别秒与毫秒", () => {
  assert.equal(core.parseTime("1720000000", "auto", "UTC"), 1720000000000);
  assert.equal(core.parseTime("1720000000000", "auto", "UTC"), 1720000000000);
  assert.equal(core.parseTime("1720000000", "s", "UTC"), 1720000000000);
  assert.equal(core.parseTime("1720000000", "ms", "UTC"), 1720000000);
});

test("parseTime 支持相对时间", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(core.parseTime("+2h", "auto", "UTC", now), now + 7200000);
  assert.equal(core.parseTime("-30m", "auto", "UTC", now), now - 1800000);
  assert.equal(core.parseTime("+1d", "auto", "UTC", now), now + 86400000);
  assert.equal(core.parseTime("+2w", "auto", "UTC", now), now + 14 * 86400000);
});

test("parseTime 按指定时区解析墙上时间", () => {
  const ms = core.parseTime("2026-10-13 09:30", "auto", "Asia/Shanghai");
  assert.equal(new Date(ms).toISOString(), "2026-10-13T01:30:00.000Z");
});

test("时区偏移覆盖夏令时切换", () => {
  const jun = Date.UTC(2026, 5, 15, 12, 0, 0);
  const nov = Date.UTC(2026, 10, 15, 12, 0, 0);
  assert.equal(core.zoneOffsetText(jun, "America/New_York"), "UTC-04:00");
  assert.equal(core.zoneOffsetText(nov, "America/New_York"), "UTC-05:00");
  assert.equal(core.zoneOffsetText(jun, "Asia/Shanghai"), "UTC+08:00");
  assert.equal(core.zoneOffsetText(jun, "UTC"), "UTC");
});

test("rfc3339 含时区偏移，零偏移用 Z", () => {
  const ms = Date.UTC(2026, 9, 15, 6, 0, 0);
  assert.equal(core.rfc3339(ms, "UTC"), "2026-10-15T06:00:00Z");
  assert.equal(core.rfc3339(ms, "Asia/Shanghai"), "2026-10-15T14:00:00+08:00");
});

test("relativeText 双向中文相对时间", () => {
  const now = Date.UTC(2026, 9, 15, 6, 0, 0);
  assert.equal(core.relativeText(now, now), "现在");
  assert.equal(core.relativeText(now + 2 * 3600000, now), "2小时后");
  assert.equal(core.relativeText(now - 3 * 86400000, now), "3天前");
});

test("timeRows 与格式模板覆盖常用格式", () => {
  const ms = Date.UTC(2026, 9, 15, 6, 0, 0);
  const rows = core.timeRows(ms, "Asia/Shanghai", ms);
  assert.ok(rows.some((r) => r.label === "Unix 秒" && r.value === "1792044000"));
  assert.ok(rows.some((r) => r.label === "相对时间"));
  const templates = core.formatTemplates(ms, "Asia/Shanghai", ms);
  const byLabel = Object.fromEntries(templates.map((t) => [t.label, t.value]));
  assert.equal(byLabel["ISO 8601（UTC）"], "2026-10-15T06:00:00.000Z");
  assert.equal(byLabel["RFC 3339（含时区）"], "2026-10-15T14:00:00+08:00");
  assert.equal(byLabel["Unix 秒"], "1792044000");
  assert.equal(byLabel["HTTP 头部（GMT）"], "Thu, 15 Oct 2026 06:00:00 GMT");
});

test("zonedToMs 往返一致且拒绝不存在的时间", () => {
  const ms = core.zonedToMs("2026-10-13 09:30:00", "Asia/Shanghai");
  assert.equal(core.formatZoned(ms, "Asia/Shanghai"), "2026-10-13 09:30:00");
  assert.throws(() => core.zonedToMs("2026-02-30 00:00:00", "UTC"), /不存在|夏令时/);
});

test("durationText 分解天时分秒", () => {
  assert.equal(core.durationText(90061000), "1 天 1 小时 1 分 1 秒");
  assert.equal(core.durationText(-3600000), "−1 小时 0 分 0 秒");
});
