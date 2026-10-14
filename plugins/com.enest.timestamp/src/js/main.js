import { parseTime, timeRows, formatZoned, durationText } from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let selected = 0,
  rows = [],
  paused = false,
  timer = null,
  visible = true,
  now = Date.now(),
  batchResult = "";
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
      selected = Math.max(
        0,
        Math.min(rows.length - 1, selected + (action === "next" ? 1 : -1)),
      );
      paint();
    }
  },
});
const zone = () => $("zone").value.trim() || "UTC";
function paint() {
  $("results").replaceChildren();
  rows.forEach((row, i) => {
    const button = document.createElement("button");
    button.className = "result-row" + (i === selected ? " selected" : "");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = row.value;
    const hint = document.createElement("span");
    hint.className = "copy-hint";
    hint.textContent = "复制";
    button.append(label, value, hint);
    button.onclick = () => {
      selected = i;
      copy(row.value);
      paint();
    };
    $("results").append(button);
  });
}
function render() {
  try {
    rows = timeRows(
      parseTime($("input").value, $("unit").value, zone(), now),
      zone(),
    );
    $("error").textContent = "";
    paint();
  } catch (e) {
    rows = [];
    $("results").replaceChildren();
    $("error").textContent =
      e instanceof RangeError
        ? "未知时区，请使用 Asia/Shanghai 等 IANA 名称"
        : e.message;
  }
}
function tick() {
  if (!paused) now = Date.now();
  try {
    $("clock").textContent = formatZoned(now, zone());
    $("clock-zone").textContent = zone();
    $("copy-now-s").textContent = Math.floor(now / 1000) + " 秒";
    $("copy-now-ms").textContent = now + " 毫秒";
    $("world-clocks").replaceChildren();
    for (const z of [
      "UTC",
      "Asia/Tokyo",
      "Europe/London",
      "America/New_York",
    ]) {
      const row = document.createElement("div");
      row.className = "world-row";
      const label = document.createElement("span");
      label.textContent = z;
      const t = document.createElement("time");
      t.textContent = formatZoned(now, z).slice(11);
      row.append(label, t);
      $("world-clocks").append(row);
    }
    if (
      !$("input").value.trim() ||
      /^(now|现在)$/i.test($("input").value.trim())
    )
      render();
  } catch {
    /* Converter presents invalid timezone. */
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
  document
    .querySelectorAll("[data-tab]")
    .forEach((el) =>
      el.setAttribute("aria-pressed", String(el.dataset.tab === name)),
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
  $("pause").textContent = paused ? "继续时钟" : "暂停时钟";
  $("pause").setAttribute("aria-pressed", String(paused));
  $("live-state").textContent = paused ? "时钟已暂停" : "时钟运行中";
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
$("batch-run").onclick = () => {
  const lines = $("batch-input")
    .value.split(/\r?\n/)
    .filter((v) => v.trim());
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
function dateMath(add) {
  try {
    const start = parseTime(
      $("date-start").value,
      $("unit").value,
      zone(),
      now,
    );
    if (add) {
      if (!/^[+-]?\d+(?:\.\d+)?[smhdw]$/i.test($("date-offset").value.trim()))
        throw new Error("偏移使用 +1d、-2h 或 +30m");
      const end = parseTime($("date-offset").value, "auto", zone(), start);
      $("date-result").textContent =
        formatZoned(end, zone()) + "\n" + end + " 毫秒";
    } else {
      const end = parseTime($("date-end").value, $("unit").value, zone(), now),
        diff = end - start;
      $("date-result").textContent =
        durationText(diff) +
        "\n" +
        diff +
        " 毫秒 / " +
        (diff / 3600000).toFixed(4) +
        " 小时";
    }
  } catch (e) {
    $("date-result").textContent = e.message;
  }
}
$("date-diff").onclick = () => dateMath(false);
$("date-add").onclick = () => dateMath(true);
$("date-copy").onclick = () => copy($("date-result").textContent);
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
$("date-start").value = formatZoned(now, zone());
$("date-end").value = formatZoned(now + 86400000, zone());
render();
start();
kit.onSettings((settings) => {
  $("zone").value = settings.timeZone || "UTC";
  $("unit").value = settings.defaultUnit || "auto";
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
