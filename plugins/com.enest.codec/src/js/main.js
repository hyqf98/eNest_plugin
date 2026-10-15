import {
  MODES,
  convert,
  convertLines,
  locateError,
  encodeDataUrl,
  parseDataUrl,
  mimeToExt,
  guessMime,
  HISTORY_KEY,
  pushHistory,
  normalizeHistory,
  formatHistoryTime,
} from "./core.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const FILE_LIMIT = 8 * 1024 * 1024;
const DEBOUNCE = 150;

let mode = "base64";
let direction = "encode";
let result = "";
let dataUrlResult = null; // 文件 → Data URL 的完整产物（可另存，不参与历史记录）
let fileMeta = null;
let history = [];
let historyTimer = null;
let routed = false;

const kit = PluginKit.create({
  title: "编解码",
  quickPlaceholder: "输入待转换文本",
  height: 490,
  defaults: { defaultMode: "base64", liveConversion: true, strictUtf8: true },
  onQuery(value) {
    $("input").value = value;
    run();
  },
  onAction(action) {
    if (action === "submit") {
      run();
      if (result) copy(result);
    } else if (action === "clear") {
      clear();
    }
  },
});

const count = (text) =>
  text.length + " 字符 · " + new TextEncoder().encode(text).length + " B";
const bytesLabel = (n) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";

/* ── 模式与方向 ─────────────────────────── */
function updateMode() {
  for (const b of $("modes").children) {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  const decodable = mode !== "jwt";
  $("dir-enc").classList.toggle("active", decodable && direction === "encode");
  $("dir-dec").classList.toggle("active", decodable && direction === "decode");
  $("dir-enc").setAttribute("aria-pressed", String(decodable && direction === "encode"));
  $("dir-dec").setAttribute("aria-pressed", String(decodable && direction === "decode"));
  for (const b of [$("dir-enc"), $("dir-dec")]) b.disabled = !decodable;
  $("mode-help").textContent =
    mode === "jwt"
      ? "只查看，不验证签名"
      : mode === "query"
        ? "解码 URL；编码二维字符串数组"
        : mode === "dataurl"
          ? "解码 Data URL；编码文本"
          : "UTF-8";
  $("input").placeholder =
    mode === "query"
      ? direction === "decode"
        ? "https://example.com/?key=value"
        : '[["key","value"]]'
      : mode === "jwt"
        ? "粘贴 JWT，离线查看 Header / Payload"
        : mode === "dataurl"
          ? "输入 Data URL 解析；或用右上角「文件转 Data URL」"
          : "输入或粘贴需要转换的内容";
  $("file-btn").hidden = mode !== "dataurl";
}

/* ── 转换主流程 ─────────────────────────── */
function reset() {
  result = "";
  $("output").value = "";
  $("copy").disabled = true;
  $("save").disabled = true;
  $("out-size").textContent = "";
  $("save-file").hidden = true;
  const batchBox = $("batch-list");
  batchBox.hidden = true;
  batchBox.replaceChildren();
  if (fileMeta) resetFile();
}

function showError(message, index = 0) {
  const box = $("error");
  box.replaceChildren();
  box.hidden = false;
  const label = document.createElement("span");
  label.textContent = "转换失败：" + message;
  box.append(label);
  if (index > 0) {
    const mark = document.createElement("button");
    mark.className = "err-locate";
    mark.type = "button";
    mark.textContent = "定位第 " + (index + 1) + " 个字符";
    mark.onclick = () => {
      const field = $("input");
      field.focus();
      field.setSelectionRange(index, index + 1);
    };
    box.append(mark);
  }
  $("status").textContent = "请检查输入内容";
}

function run() {
  const text = $("input").value;
  $("in-size").textContent = text ? count(text) : "";
  const errorBox = $("error");
  errorBox.replaceChildren();
  errorBox.hidden = true;
  reset();
  if (!text) {
    $("status").textContent = "所有转换均在本地完成";
    return;
  }
  const options = { strictUtf8: kit.settings.strictUtf8 !== false };
  try {
    const started = performance.now();
    if ($("batch").checked) {
      const rows = convertLines(text, mode, direction, options);
      const failed = rows.filter((r) => !r.ok);
      result = rows
        .map((r) => (r.ok ? r.value : `[第 ${r.line} 行错误] ${r.value}`))
        .join("\n");
      const box = $("batch-list");
      box.replaceChildren(
        ...rows.map((r) => {
          const item = document.createElement("div");
          item.className = "batch-row" + (r.ok ? "" : " bad");
          const no = document.createElement("span");
          no.className = "batch-line num";
          no.textContent = String(r.line);
          const value = document.createElement("code");
          value.textContent = r.value;
          item.append(no, value);
          return item;
        }),
      );
      box.hidden = false;
      $("status").textContent =
        rows.filter((r) => r.ok).length + "/" + rows.length + " 行成功";
    } else {
      result = convert(text, mode, direction, options);
      $("status").textContent =
        "本地转换 · " + (performance.now() - started).toFixed(1) + " ms";
    }
    $("output").value = result;
    $("out-size").textContent = count(result);
    $("copy").disabled = !result;
    $("save").disabled = !result;
  } catch (e) {
    const located = locateError(text, mode, direction, options);
    showError(located ? located.message : e.message, located?.index || 0);
  }
}

/* ── 工具条与面板动作 ─────────────────────── */
function clear() {
  $("input").value = "";
  $("in-size").textContent = "";
  $("error").replaceChildren();
  $("error").hidden = true;
  reset();
  $("input").focus();
}
async function copy(text) {
  try {
    await kit.copy(text);
    remember();
  } catch (error) {
    kit.toast(error.message, "error");
  }
}

for (const [key, label] of Object.entries(MODES)) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.dataset.mode = key;
  b.onclick = () => {
    mode = key;
    if (mode === "jwt" || mode === "query") direction = "decode";
    updateMode();
    run();
  };
  $("modes").append(b);
}
$("dir-enc").onclick = () => {
  direction = "encode";
  updateMode();
  run();
};
$("dir-dec").onclick = () => {
  direction = "decode";
  updateMode();
  run();
};
$("run").onclick = run;
$("clear").onclick = clear;
$("copy").onclick = () => result && copy(result);
$("save").onclick = () => result && saveText("codec-" + mode + ".txt", result);
$("swap").onclick = () => {
  if (!result) return;
  $("input").value = result;
  direction = direction === "encode" ? "decode" : "encode";
  updateMode();
  run();
};
let debounce;
$("input").oninput = () => {
  reset();
  $("error").replaceChildren();
  $("error").hidden = true;
  $("in-size").textContent = count($("input").value);
  clearTimeout(debounce);
  if ($("live").checked) debounce = setTimeout(run, DEBOUNCE);
};$("live").onchange = () => {
  if ($("live").checked) run();
};
$("batch").onchange = run;
$("paste").onclick = async () => {
  try {
    $("input").value = await api.clipboard.readText();
    run();
  } catch (e) {
    kit.toast("无法读取剪贴板：" + e.message, "error");
  }
};

/* ── 文件 → Data URL（宿主文件选择即授权）─────── */
$("file-btn").onclick = () => $("file-input").click();
$("file-chip").onclick = () => {
  if (fileMeta) saveDataUrlFile();
};
$("file-input").addEventListener("change", () => {
  const file = $("file-input").files?.[0];
  if (file) void importFile(file);
});
async function importFile(file) {
  if (file.size > FILE_LIMIT) {
    kit.toast("文件超过 8 MB，无法生成 Data URL", "error");
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || guessMime(file.name);
    const url = encodeDataUrl(bytes, mime);
    const meta = { name: file.name, size: file.size, mime };
    // 先复位旧态，再落新值（reset 会清 fileMeta，故顺序如此）
    reset();
    fileMeta = meta;
    dataUrlResult = url;
    direction = "encode";
    updateMode();
    $("input").value = "";
    $("in-size").textContent = "";
    const out = $("output");
    out.value = url;
    result = url;
    $("out-size").textContent = meta.name + " · " + bytesLabel(meta.size);
    $("copy").disabled = false;
    $("save").disabled = false;
    $("save-file").hidden = false;
    const chip = $("file-chip");
    chip.hidden = false;
    chip.textContent = meta.name + " · " + bytesLabel(meta.size) + " · 点击另存";
    $("status").textContent = "Data URL 生成完毕（本地，未经过网络）";
  } catch (e) {
    kit.toast("读取文件失败：" + e.message, "error");
  }
}
function resetFile() {
  fileMeta = null;
  dataUrlResult = null;
  $("file-chip").hidden = true;
  $("file-chip").textContent = "";
  $("file-input").value = "";
}
function saveDataUrlFile() {
  if (!dataUrlResult || !fileMeta) return;
  return kit.saveFile(fileMeta.name + ".txt", dataUrlResult).catch((e) => kit.toast(e.message, "error"));
}
$("save-file").onclick = () => {
  if (!result) return;
  if (dataUrlResult) return saveDataUrlFile();
  if (/^data:([^;,]+);base64,/.test(result)) {
    const info = parseDataUrl(result);
    return kit.saveFile("dataurl." + mimeToExt(info.mime), result)
      .catch((e) => kit.toast(e.message, "error"));
  }
  saveText("codec-dataurl.txt", result);
};

/* ── 最近转换记录 ─────────────────────────── */
function remember() {
  const text = $("input").value;
  if (!text || !result) return;
  const entry = { text: text.slice(0, 4000), mode, direction, at: Date.now() };
  history = pushHistory(history, entry);
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    kit.save(HISTORY_KEY, history).catch(() => {});
  }, 400);
  renderHistory();
}
function renderHistory() {
  const list = $("history-list");
  list.replaceChildren(
    ...history.map((row) => {
      const li = document.createElement("li");
      li.className = "history-item";
      const preview = document.createElement("code");
      preview.className = "history-text";
      preview.textContent = row.text.replace(/\s+/g, " ").slice(0, 60);
      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent =
        MODES[row.mode] + " · " + (row.direction === "encode" ? "编码" : "解码") + " · " + formatHistoryTime(row.at);
      li.append(preview, meta);
      li.onclick = () => {
        $("history-panel").hidden = true;
        $("history").setAttribute("aria-expanded", "false");
        mode = row.mode;
        direction = row.direction;
        updateMode();
        $("input").value = row.text;
        run();
        $("input").focus();
      };
      return li;
    }),
  );
  $("history-empty").hidden = history.length > 0;
}
$("history").onclick = () => {
  const panel = $("history-panel");
  panel.hidden = !panel.hidden;
  $("history").setAttribute("aria-expanded", String(!panel.hidden));
};
$("history-clear").onclick = () => {
  history = [];
  kit.save(HISTORY_KEY, history).catch(() => {});
  renderHistory();
};
document.addEventListener("click", (e) => {
  const panel = $("history-panel");
  if (!panel.hidden && !e.target.closest("#history-panel") && !e.target.closest("#history")) {
    panel.hidden = true;
    $("history").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    run();
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    run();
    if (result) copy(result);
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
    e.preventDefault();
    $("history").click();
  }
});

api?.onEnter?.(({ code, payload }) => {
  if (code && MODES[code]) {
    routed = true;
    mode = code;
    direction = ["jwt", "query"].includes(mode) ? "decode" : direction;
    updateMode();
  }
  const text = typeof payload === "string" ? payload : payload?.text;
  if (text) {
    $("input").value = text;
    run();
  }
  $("input").focus();
});

await kit.ready;
if (!routed && MODES[kit.settings.defaultMode]) {
  mode = kit.settings.defaultMode;
}
if (["jwt", "query"].includes(mode)) direction = "decode";
$("live").checked = kit.settings.liveConversion !== false;
history = normalizeHistory(await kit.load(HISTORY_KEY, []));
renderHistory();
updateMode();
run();
kit.onSettings(() => {
  $("live").checked = kit.settings.liveConversion !== false;
  run();
});

function saveText(name, content) {
  return kit.saveText(name, content).catch((error) => {
    kit.toast(error.message, "error");
    return null;
  });
}
