import {
  DOMAINS,
  WEEK_LABELS,
  PRESETS,
  FIELD_CHIPS,
  MACROS,
  parseExpression,
  nextFire,
  describe,
  formatSchedule,
  parseCrontabLine,
} from "./core.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const esc = PluginKit.escape;

const kit = PluginKit.create({
  title: "Cron 工具",
  quickPlaceholder: "粘贴 cron 表达式，即时解析并预览执行时间",
  height: 460,
  defaults: { withSeconds: false, timezone: "local", previewCount: "10" },
  onQuery: (value) => {
    $("expression").value = String(value);
    render();
  },
  onAction: (action) => {
    if (action === "clear") {
      $("expression").value = "";
      render();
    } else if (action === "submit") void $("copy-expression").disabled || kit.copy($("expression").value);
  },
});

const PRESET_KEY = "cron_presets_v1";
const BUILTIN_TAG = "builtin";

let userPresets = [];
let lastFires = [];
let previewCount = 10;

/* ── 初始化 ─────────────────────────── */
const fieldBox = (d, shown) =>
  `<div class="field-box" data-domain="${esc(d.key)}"><h3>${esc(d.label)}<span class="mono" data-value>${esc(shown)}</span></h3><div class="chips">${(FIELD_CHIPS[d.key] || [])
    .map(
      (c) =>
        `<button data-chip="${esc(c.value)}" title="${esc(c.title || c.label)}">${esc(c.label)}</button>`,
    )
    .join("")}</div><input data-input spellcheck="false" placeholder="手动输入：* 或 1-5 或 1,15" /></div>`;

$("preset-list").innerHTML = PRESETS.map(
  (p, i) =>
    `<li data-preset="b${i}" title="${esc(p.expr)}"><span class="name">${esc(p.name)}</span><span class="expr">${esc(p.expr)}</span></li>`,
).join("");

(async () => {
  await kit.ready;
  const saved = await kit.load(PRESET_KEY, null);
  if (Array.isArray(saved)) userPresets = saved.slice(0, 100);
  setSecondsMode(!!kit.settings.withSeconds, { silent: true });
  if (kit.settings.timezone === "UTC") {
    $("timezone").value = "UTC";
    PluginKit.upgradeSelects(); // 纯 .value 赋值不触发 change，同步自定义下拉标签
  }
  const savedCount = Number(kit.settings.previewCount);
  previewCount = [5, 10, 20].includes(savedCount) ? savedCount : 10;
  for (const b of document.querySelectorAll("#count-switch [data-count]"))
    togglePressed(b, Number(b.dataset.count) === previewCount);
  rebuildFields();
  renderPresets();
  if (!$("expression").value) $("expression").value = "*/5 * * * *";
  render();
})();

function togglePressed(button, on) {
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", String(on));
}

/* ── 渲染 ─────────────────────────── */
function currentParts() {
  const withSeconds = document.documentElement.dataset.cronMode === "6";
  const order = withSeconds ? DOMAINS : DOMAINS.slice(1);
  const parts = order.map((d) => {
    const box = $(`fields`).querySelector(`[data-domain="${d.key}"]`);
    const value = box ? box.querySelector("[data-input]").value.trim() : "";
    return value || "*";
  });
  return { withSeconds, parts };
}

function render() {
  const { withSeconds, parts } = currentParts();
  const expr = parts.join(" ");
  clearError();
  let schedule = null;
  if (parts.some((p) => p !== "*") || expr.replace(/\*/g, "").trim() === "") {
    try {
      schedule = parseExpression(expr, { withSeconds });
      $("copy-expression").disabled = false;
      $("preset-save").disabled = false;
    } catch (e) {
      showError(e.message);
      schedule = null;
    }
  }
  $("humanize").textContent = schedule ? describe(schedule) : "";
  document.title = schedule ? `Cron · ${expr}` : "Cron 工具";
  renderFires(schedule);
  renderCrontab(schedule);
}

function setSecondsMode(on, { silent = false } = {}) {
  document.documentElement.dataset.cronMode = on ? "6" : "5";
  togglePressed($("mode-5"), !on);
  togglePressed($("mode-6"), on);
  if (!silent) {
    applyExpressionToFields($("expression").value.trim(), on);
    render();
  } else rebuildFields();
}

function rebuildFields() {
  const withSeconds = document.documentElement.dataset.cronMode === "6";
  const previous = currentParts().parts;
  const order = withSeconds ? DOMAINS : DOMAINS.slice(1);
  $("fields").innerHTML = order
    .map((d, i) => {
      const value = withSeconds ? previous[i] : previous[i - 1] || "*";
      return fieldBox(d, value);
    })
    .join("");
}

function applyExpressionToFields(expr, withSeconds) {
  let schedule;
  try {
    schedule = parseExpression(expr, { withSeconds });
  } catch {
    return false;
  }
  document.documentElement.dataset.cronMode = withSeconds ? "6" : "5";
  togglePressed($("mode-5"), !withSeconds);
  togglePressed($("mode-6"), withSeconds);
  rebuildFields();
  const order = withSeconds ? DOMAINS : DOMAINS.slice(1);
  for (const d of order) {
    const box = $("fields").querySelector(`[data-domain="${d.key}"]`);
    const input = box.querySelector("[data-input]");
    const canonical = canonicalField(schedule.sets[d.index], d);
    input.value = canonical;
    box.querySelector("[data-value]").textContent = canonical;
  }
  return true;
}

/** 由值集合反推单域简洁写法 */
function canonicalField(set, domain) {
  const arr = [...set].sort((a, b) => a - b);
  if (arr.length === domain.max - domain.min + 1) return "*";
  if (arr.length === 1) return String(arr[0]);
  const diff = arr[1] - arr[0];
  const steady = arr.length > 2 && arr.every((v, i) => i < 2 || v - arr[i - 1] === diff);
  if (steady && arr[0] === domain.min && arr[arr.length - 1] + diff > domain.max) return `*/${diff}`;
  if (steady) return `${arr[0]}-${arr[arr.length - 1]}/${diff}`;
  return arr.join(",");
}

function showError(message) {
  $("expr-error").textContent = message;
  $("expr-error").hidden = false;
}
function clearError() {
  $("expr-error").hidden = true;
}

const pad = (n) => String(n).padStart(2, "0");
const inSecondsMode = () => document.documentElement.dataset.cronMode === "6";
function formatLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${inSecondsMode() ? ":" + pad(d.getSeconds()) : ""}`;
}
function formatUtc(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${inSecondsMode() ? ":" + pad(d.getUTCSeconds()) : ""}`;
}
function countdown(ms) {
  if (ms < 0) return "已过期";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时`;
  const dayCount = Math.round(h / 24);
  if (dayCount < 60) return `${dayCount} 天`;
  return `${(dayCount / 365).toFixed(1)} 年`;
}

let fireTimer;
let fireSchedule = null;
function renderFires(schedule) {
  const tbody = $("fire-list");
  fireSchedule = schedule;
  if (!schedule) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="empty-note">表达式有效后展示未来执行时间。</td></tr>';
    $("upcoming-count").textContent = "";
    return;
  }
  try {
    lastFires = nextFire(schedule, new Date(), previewCount);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-note">${esc(e.message)}</td></tr>`;
    $("upcoming-count").textContent = "";
    return;
  }
  $("upcoming-count").textContent = `· 未来 ${lastFires.length} 次`;
  paintFires();
  clearTimeout(fireTimer);
  fireTimer = setTimeout(() => {
    if (fireSchedule) renderFires(fireSchedule);
  }, 30000);
}

/* 只重绘相对列与时间列，30 秒 / 1 秒粒度复用已算好的 lastFires */
function paintFires() {
  const tbody = $("fire-list");
  const utcMode = $("timezone").value === "UTC";
  $("tz-label").textContent = utcMode ? "UTC 时间" : "本地时间";
  $("tz-alt-label").textContent = utcMode ? "本地对照" : "UTC 对照";
  const now = Date.now();
  tbody.innerHTML = lastFires
    .map((d, i) => {
      const primary = utcMode ? formatUtc(d) : formatLocal(d);
      const alt = utcMode ? formatLocal(d) : formatUtc(d);
      return `<tr><td class="idx mono">${i + 1}</td><td class="mono">${primary}</td><td class="mono alt">${alt}</td><td class="rel">${esc(countdown(d.getTime() - now))}</td></tr>`;
    })
    .join("");
}

function renderCrontab(schedule) {
  const status = $("crontab-status");
  const exportBtn = $("crontab-export");
  if (schedule) {
    status.textContent = `当前：${schedule.raw}`;
    exportBtn.disabled = false;
  } else {
    status.textContent = "表达式无效，无法导出";
    exportBtn.disabled = true;
  }
}

/* ── 预设 ─────────────────────────── */
function renderPresets() {
  const list = $("preset-list");
  const builtin = PRESETS.map(
    (p, i) =>
      `<li data-preset="b${i}" title="${esc(p.expr)}"><span class="name">${esc(p.name)}</span><span class="expr">${esc(p.expr)}</span></li>`,
  );
  const custom = userPresets.map(
    (p, i) =>
      `<li data-preset="u${i}" title="${esc(p.expr)}"><span class="name">${esc(p.name)}</span><button class="del" data-del-preset="${i}" aria-label="删除 ${esc(p.name)}">×</button><span class="expr">${esc(p.expr)}</span></li>`,
  );
  list.innerHTML = [...builtin, ...custom].join("");
  $("preset-source").textContent = userPresets.length ? `内置 + 自定义 ${userPresets.length}` : BUILTIN_TAG;
}

async function persistPresets() {
  try {
    await kit.save(PRESET_KEY, userPresets);
  } catch (e) {
    kit.toast(e.message, "error");
  }
}

/* ── 事件 ─────────────────────────── */
let debounce;
const scheduleRender = () => {
  clearTimeout(debounce);
  debounce = setTimeout(render, 150);
};
$("expression").addEventListener("input", scheduleRender);
$("mode-5").addEventListener("click", () => setSecondsMode(false));
$("mode-6").addEventListener("click", () => setSecondsMode(true));
$("count-switch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-count]");
  if (!b) return;
  previewCount = Number(b.dataset.count);
  for (const x of document.querySelectorAll("#count-switch [data-count]"))
    togglePressed(x, x === b);
  void api?.storage?.set?.("cron_preview_count", String(previewCount)).catch?.(() => {});
  render();
});
$("fields").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-chip]");
  if (!chip) return;
  const box = chip.closest("[data-domain]");
  const input = box.querySelector("[data-input]");
  input.value = chip.dataset.chip;
  box.querySelector("[data-value]").textContent = input.value || "*";
  syncExpressionFromFields();
});
$("fields").addEventListener("input", (e) => {
  const input = e.target.closest("[data-input]");
  if (!input) return;
  const box = input.closest("[data-domain]");
  box.querySelector("[data-value]").textContent = input.value.trim() || "*";
  syncExpressionFromFields();
});

function syncExpressionFromFields() {
  const { parts } = currentParts();
  $("expression").value = parts.join(" ");
  scheduleRender();
}

$("timezone").addEventListener("change", () => {
  render();
  void api?.storage
    ?.set?.("cron_tz_preview", $("timezone").value)
    .catch?.(() => {});
});

$("copy-expression").onclick = () =>
  kit.copy($("expression").value.trim()).catch((e) => kit.toast(e.message, "error"));

$("preset-list").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-preset]");
  if (del) {
    userPresets.splice(Number(del.dataset.delPreset), 1);
    void persistPresets();
    renderPresets();
    return;
  }
  const row = e.target.closest("[data-preset]");
  if (!row) return;
  const key = row.dataset.preset;
  const preset = key.startsWith("b")
    ? PRESETS[Number(key.slice(1))]
    : userPresets[Number(key.slice(1))];
  if (!preset) return;
  const withSeconds = preset.expr.trim().split(/\s+/).length === 6;
  if (applyExpressionToFields(preset.expr, withSeconds)) {
    $("expression").value = preset.expr;
    render();
  }
});
$("preset-save").onclick = () => {
  const expr = $("expression").value.trim();
  const human = $("humanize").textContent || expr;
  if (!expr) return;
  userPresets = [{ name: human.slice(0, 30) || expr, expr }, ...userPresets.filter((p) => p.expr !== expr)].slice(0, 100);
  void persistPresets();
  renderPresets();
  kit.toast("已保存到预设库", "success");
};
$("preset-reset").onclick = () => {
  userPresets = [];
  void persistPresets();
  renderPresets();
  kit.toast("已恢复内置预设", "info");
};

/* crontab 粘贴解析与导出 */
$("crontab-parse").onclick = () => {
  const lines = $("crontab").value.split("\n");
  const parsed = [];
  const errors = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const expr = parseCrontabLine(line);
      if (expr) {
        parseExpression(expr, { withSeconds: expr.split(/\s+/).length === 6 });
        parsed.push({ line: i + 1, expr });
      }
    } catch (e) {
      errors.push(`第 ${i + 1} 行：${e.message}`);
    }
  }
  const status = $("crontab-status");
  if (errors.length) {
    status.textContent = errors.slice(0, 3).join("；");
    kit.toast(errors[0], "error");
    return;
  }
  if (!parsed.length) {
    status.textContent = "没有可解析的行（空行与注释会被跳过）";
    return;
  }
  const first = parsed[0];
  applyExpressionToFields(first.expr, first.expr.split(/\s+/).length === 6);
  $("expression").value = first.expr;
  render();
  status.textContent = `已解析 ${parsed.length} 行，构建器载入第 ${first.line} 行`;
  kit.toast(`已载入第 ${first.line} 行表达式`, "success");
};

$("crontab-export").onclick = () => {
  const { parts } = currentParts();
  const expr = parts.join(" ");
  const lines = $("crontab")
    .value.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("@"));
  const body = lines.length ? lines.map((l) => `${l}  # 由构建器保留`).join("\n") : "";
  const entry = `${expr}  # ${$("humanize").textContent || "eNest Cron 构建器"}`;
  kit.copy(body ? `${body}\n${entry}` : entry).catch((e) => kit.toast(e.message, "error"));
};

render();
