import { parseTime, timeRows, formatZoned, formatTemplates, durationText, zoneOffsetText } from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
const WORLD_KEY = "timestamp.worldZones.v1";
const RECENT_KEY = "timestamp.recents.v1";
let selected = 0,
  rows = [],
  paused = false,
  timer = null,
  visible = true,
  now = Date.now(),
  batchResult = "",
  worldZones = [],
  recents = [];
const kit = PluginKit.create({
  title: "时间戳",
  quickPlaceholder: "时间戳、日期或 +30m",
  height: 480,
  defaults: {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultUnit: "auto",
    batchFormat: "date",
  },
  onQuery(value) {
    $("input").value = value;
    render();
  },
  onAction(action) {
    if (action === "submit") {
      if (rows[selected]) copy(rows[selected].value);
    } else if (action === "clear") {
      $("input").value = "";
      render();
    } else {
      selected = Math.max(0, Math.min(rows.length - 1, selected + (action === "next" ? 1 : -1)));
      paint();
    }
  },
});
const zone = () => $("zone").value.trim() || "UTC";

/* —— 结果行（点击复制 + 键盘选择）—— */
function paint() {
  $("results").replaceChildren();
  rows.forEach((row, i) => {
    const button = document.createElement("button");
    button.className = "result-row" + (i === selected ? " selected" : "");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "value mono";
    value.textContent = row.value;
    const hint = document.createElement("span");
    hint.className = "copy-hint";
    hint.textContent = "复制";
    button.append(label, value, hint);
    button.onclick = () => {
      selected = i;
      copy(row.value);
      remember($("input").value.trim(), row.value);
      paint();
    };
    $("results").append(button);
  });
}
function render() {
  try {
    rows = timeRows(parseTime($("input").value, $("unit").value, zone(), now), zone(), now);
    $("error").textContent = "";
    paint();
    renderTemplates();
  } catch (e) {
    rows = [];
    $("results").replaceChildren();
    $("template-grid").replaceChildren();
    $("error").textContent =
      e instanceof RangeError ? "未知时区，请使用 Asia/Shanghai 等 IANA 名称" : e.message;
  }
}
function renderTemplates() {
  const grid = $("template-grid");
  grid.replaceChildren();
  let ms;
  try {
    ms = parseTime($("input").value, $("unit").value, zone(), now);
  } catch {
    return;
  }
  for (const t of formatTemplates(ms, zone(), now)) {
    const card = document.createElement("button");
    card.className = "template-card";
    const label = document.createElement("span");
    label.className = "t-label";
    label.textContent = t.label;
    const value = document.createElement("span");
    value.className = "t-value mono";
    value.textContent = t.value;
    card.append(label, value);
    card.onclick = () => {
      copy(t.value);
      remember($("input").value.trim(), t.value);
    };
    grid.append(card);
  }
}

/* —— 收藏 / 历史转换（向后兼容：新 key，不碰旧数据）—— */
function remember(expr, value) {
  if (!expr || /^(now|现在)$/i.test(expr)) return;
  recents = recents.filter((r) => r.expr !== expr);
  recents.unshift({ expr, value, at: Date.now() });
  recents = recents.slice(0, 20);
  kit.save(RECENT_KEY, recents).catch(() => {});
}
async function loadRecents() {
  const saved = await kit.load(RECENT_KEY, []);
  if (Array.isArray(saved)) recents = saved.filter((r) => r && r.expr).slice(0, 20);
}

/* —— 世界时钟 —— */
function paintWorld() {
  const host = $("world-clocks");
  host.replaceChildren();
  const list = [zone(), ...worldZones.filter((z) => z !== zone())];
  for (const z of list) {
    const row = document.createElement("div");
    row.className = "world-row" + (z === zone() ? " primary" : "");
    const name = document.createElement("button");
    name.className = "world-name";
    name.textContent = z.split("/").pop().replace(/_/g, " ");
    name.title = z + " · 点击设为转换时区";
    name.onclick = () => {
      $("zone").value = z;
      render();
      tick();
    };
    const right = document.createElement("span");
    right.className = "world-right";
    const t = document.createElement("time");
    t.className = "mono";
    t.textContent = formatZoned(now, z).slice(11);
    const off = document.createElement("span");
    off.className = "world-offset";
    off.textContent = zoneOffsetText(now, z).replace("UTC", "");
    right.append(t, off);
    const del = document.createElement("button");
    del.className = "world-del";
    del.textContent = "⌫";
    del.setAttribute("aria-label", "移除 " + z);
    del.tabIndex = z === zone() ? -1 : 0;
    if (z !== zone())
      del.onclick = () => {
        worldZones = worldZones.filter((x) => x !== z);
        kit.save(WORLD_KEY, worldZones).catch(() => {});
        paintWorld();
      };
    row.append(name, right, del);
    host.append(row);
  }
}
function addWorldZone() {
  const value = $("zone-add").value.trim();
  if (!value) return;
  try {
    formatZoned(now, value);
  } catch {
    kit.toast("未知时区，请使用 IANA 名称", "error");
    return;
  }
  if (value === zone() || worldZones.includes(value)) {
    kit.toast("该时区已在列表中", "info");
    $("zone-add").value = "";
    return;
  }
  worldZones.push(value);
  if (worldZones.length > 6) worldZones = worldZones.slice(-6);
  kit.save(WORLD_KEY, worldZones).catch(() => {});
  $("zone-add").value = "";
  paintWorld();
}

/* —— 时钟心跳 —— */
function tick() {
  if (!paused) now = Date.now();
  try {
    $("clock").textContent = formatZoned(now, zone());
    $("clock-zone").textContent = zone();
    $("clock-offset").textContent = zoneOffsetText(now, zone());
    $("copy-now-s").querySelector(".now-num").textContent = Math.floor(now / 1000);
    $("copy-now-ms").querySelector(".now-num").textContent = now;
    $("footer-clock").textContent = formatZoned(now, zone());
    paintWorld();
    if (!$("input").value.trim() || /^(now|现在)$/i.test($("input").value.trim())) render();
  } catch {
    /* 转换器已展示无效时区错误 */
  }
}
function start() {
  clearInterval(timer);
  if (visible && !paused) timer = setInterval(tick, 1000);
  tick();
}
function tab(name) {
  document.querySelectorAll("[data-page]").forEach((el) => {
    el.hidden = el.dataset.page !== name;
  });
  document.querySelectorAll("[data-tab]").forEach((el) =>
    el.setAttribute("aria-selected", String(el.dataset.tab === name)),
  );
}
document.querySelectorAll("[data-tab]").forEach((el) => {
  el.onclick = () => tab(el.dataset.tab);
});
$("input").oninput = render;
$("unit").onchange = render;
$("zone").onchange = () => {
  render();
  tick();
};
document.querySelectorAll("[data-relative]").forEach((el) => {
  el.onclick = () => {
    $("input").value = el.dataset.relative;
    now = Date.now();
    render();
  };
});
$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "继续" : "暂停";
  $("pause").setAttribute("aria-pressed", String(paused));
  $("live-state").textContent = paused ? "时钟已暂停" : "时钟运行中";
  $("live-dot").dataset.state = paused ? "paused" : "running";
  start();
};
$("use-now").onclick = () => {
  $("input").value = "";
  now = Date.now();
  tab("convert");
  render();
};
$("copy-now-s").onclick = () => copy(String(Math.floor(now / 1000)));
$("copy-now-ms").onclick = () => copy(String(now));
$("zone-add-btn").onclick = addWorldZone;
$("zone-add").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addWorldZone();
  }
};

/* —— 批量 —— */
$("batch-run").onclick = () => {
  const lines = $("batch-input").value.split(/\r?\n/).filter((v) => v.trim());
  if (lines.length > 1000) return kit.toast("每批最多 1000 行", "warn");
  const snapshot = Date.now();
  batchResult = lines
    .map((line) => {
      try {
        const ms = parseTime(line, $("unit").value, zone(), snapshot),
          f = $("batch-format").value;
        return (
          line +
          "\t" +
          (f === "iso"
            ? new Date(ms).toISOString()
            : f === "s"
              ? Math.floor(ms / 1000)
              : f === "ms"
                ? ms
                : formatZoned(ms, zone()))
        );
      } catch (e) {
        return line + "\t错误：" + e.message;
      }
    })
    .join("\n");
  $("batch-output").textContent = batchResult || "先输入需要转换的内容";
};
$("batch-copy").onclick = () => batchResult && copy(batchResult);
$("batch-save").onclick = () =>
  batchResult && saveText("timestamps.tsv", "输入\t结果\n" + batchResult);

/* —— 日期计算 —— */
function dateDiff() {
  try {
    const start = parseTime($("date-start").value, $("unit").value, zone(), now);
    const end = parseTime($("date-end").value, $("unit").value, zone(), now);
    const diff = end - start;
    $("date-result").textContent =
      durationText(diff) + "\n" + diff + " 毫秒 / " + (diff / 3600000).toFixed(4) + " 小时";
  } catch (e) {
    $("date-result").textContent = e.message;
  }
}
function dateAdd() {
  try {
    const offset = $("date-offset").value.trim();
    if (!/^[+-]?\d+(?:\.\d+)?[smhdw]$/i.test(offset))
      throw new Error("偏移使用 +1d、-2h 或 +30m");
    const baseText = $("date-add-start").value.trim() || $("date-start").value;
    const start = parseTime(baseText, $("unit").value, zone(), now);
    const end = parseTime(offset, "auto", zone(), start);
    $("add-result").textContent =
      formatZoned(end, zone()) + "\n" + end + " 毫秒";
  } catch (e) {
    $("add-result").textContent = e.message;
  }
}
$("date-diff").onclick = dateDiff;
$("date-add").onclick = dateAdd;
$("add-copy").onclick = () => copy($("add-result").textContent);
["date-start", "date-end"].forEach((id) =>
  $(id).addEventListener("input", dateDiff),
);
["date-add-start", "date-offset"].forEach((id) =>
  $(id).addEventListener("input", dateAdd),
);

api?.onOut?.(() => {
  visible = false;
  clearInterval(timer);
});
api?.onDestroy?.(() => clearInterval(timer));
api?.onEnter?.(({ payload }) => {
  visible = true;
  const text = typeof payload === "string" ? payload : payload?.text;
  if (text) {
    $("input").value = text;
    tab("convert");
    render();
  }
  start();
});
await kit.ready;
$("zone").value = kit.settings.timeZone || "UTC";
try {
  formatZoned(now, zone());
} catch {
  $("zone").value = "UTC";
  kit.toast("默认时区无效，已使用 UTC", "warn");
}
$("unit").value = kit.settings.defaultUnit || "auto";
$("batch-format").value = kit.settings.batchFormat || "date";
PluginKit.upgradeSelects(); // 恢复设置后同步两个自定义下拉的触发器标签
const savedZones = await kit.load(WORLD_KEY, []);
if (Array.isArray(savedZones))
  worldZones = savedZones.filter((z) => typeof z === "string" && z.includes("/")).slice(0, 6);
await loadRecents();
$("date-start").value = formatZoned(now, zone());
$("date-end").value = formatZoned(now + 86400000, zone());
render();
start();
kit.onSettings((settings) => {
  $("zone").value = settings.timeZone || "UTC";
  $("unit").value = settings.defaultUnit || "auto";
  PluginKit.upgradeSelects(); // 设置热更新改值后同步下拉标签
  render();
  tick();
});

function copy(text) {
  return kit.copy(text).catch((error) => {
    kit.toast(error.message, "error");
    return false;
  });
}
function saveText(name, content) {
  return kit.saveText(name, content).catch((error) => {
    kit.toast(error.message, "error");
    return null;
  });
}
