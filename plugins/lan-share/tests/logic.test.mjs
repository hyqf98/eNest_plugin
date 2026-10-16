import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const util = await import(
  pathToFileURL(resolve(root, "plugins/lan-share/src/js/util.mjs"))
);
const history = await import(
  pathToFileURL(resolve(root, "plugins/lan-share/src/js/history.mjs"))
);

test("fmtBytes walks units with one decimal (two for GB)", () => {
  assert.equal(util.fmtBytes(0), "0 B");
  assert.equal(util.fmtBytes(512), "512 B");
  assert.equal(util.fmtBytes(1024), "1.0 KB");
  assert.equal(util.fmtBytes(1536), "1.5 KB");
  assert.equal(util.fmtBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(util.fmtBytes(2.5 * 1024 ** 3), "2.50 GB");
});

test("fmtBytes rejects invalid input", () => {
  assert.equal(util.fmtBytes(-5), "0 B");
  assert.equal(util.fmtBytes(NaN), "0 B");
});

test("fmtRemain clamps and pads mm:ss", () => {
  assert.equal(util.fmtRemain(65_000), "01:05");
  assert.equal(util.fmtRemain(0), "00:00");
  assert.equal(util.fmtRemain(-12_000), "00:00");
  assert.equal(util.fmtRemain(600_000), "10:00");
});

test("history round-trips v1 payload (legacy files string)", () => {
  const v1 = [
    { files: "a.txt、b.txt", count: 2, downloads: 3, ts: 1_700_000_000_000, shareId: "s1" },
  ];
  const entries = history.loadHistory(v1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].names, "a.txt、b.txt");
  assert.equal(entries[0].downloads, 3);
  assert.equal(entries[0].shareId, "s1");
  assert.equal(history.historyLine(entries[0]), "2 个文件 · a.txt、b.txt");
  assert.match(history.historyMeta(entries[0]), /下载 3 次/);
});

test("history push dedupes by shareId and caps length", () => {
  let entries = history.loadHistory([]);
  for (let i = 0; i < 60; i++) {
    entries = history.pushHistory(entries, { names: `f${i}`, count: 1, totalSize: i, downloads: 0, ts: i, shareId: `s${i}` });
  }
  assert.equal(entries.length, history.HISTORY_LIMIT);
  assert.equal(entries[0].shareId, "s59");
  entries = history.pushHistory(entries, { names: "dup", count: 1, totalSize: 0, downloads: 0, ts: 99, shareId: "s59" });
  assert.equal(entries.length, history.HISTORY_LIMIT);
  assert.equal(entries[0].names, "dup");
});

test("recordFromShare folds LanShareStatus into one entry", () => {
  const share = {
    shareId: "share-1",
    startedAt: 1_710_000_000_000,
    files: [
      { id: "f1", name: "报告.pdf", size: 1024 },
      { id: "f2", name: "照片.png", size: 2048 },
    ],
  };
  const record = history.recordFromShare(share);
  assert.equal(record.count, 2);
  assert.equal(record.totalSize, 3072);
  assert.equal(record.downloads, 0);
  assert.equal(record.shareId, "share-1");
  assert.match(record.names, /报告\.pdf、照片\.png/);
});
