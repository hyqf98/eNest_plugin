/* 文本对比 — 双栏输入 + 并排/统一双视图 + 字符级行内高亮 + 差异导航与统计 +
   忽略空白/大小写/空行 + JSON 规范化对比 + unified patch 复制/导出。 */
import {
  diffLines,
  countChanges,
  pairHunks,
  diffChars,
  unifiedDiff,
  hexDump,
  normalizeJsonPair,
} from "./core.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const esc = PluginKit.escape;

const HEX_KEY = "diff_hex_mode_v1";
const PREF_KEY = "diff_prefs_v2";

const kit = PluginKit.create({
  title: "文本对比",
  quickPlaceholder: "两栏粘贴文本，实时对比差异",
  height: 480,
  defaults: { inline: true, ignoreWhitespace: false, ignoreCase: false, hexMode: false },
  onAction: (action) => {
    if (action === "clear") {
      $("source").value = "";
      $("target").value = "";
      render();
    } else if (action === "submit") $("target").focus();
  },
});

let ops = []; // 渲染行模型：{ el, changeIndex? }
let currentChange = -1;
let hexMode = false;
let view = "split"; // split | unified
let jsonNotice = ""; // JSON 规范化降级提示

const prefs = {
  inline: true,
  ignoreWhitespace: false,
  ignoreCase: false,
  ignoreBlank: false,
  jsonNormalize: false,
};

(async () => {
  await kit.ready;
  Object.assign(prefs, await kit.load(PREF_KEY, {}));
  syncOptionButtons();
  hexMode = !!(await kit.load(HEX_KEY, false));
  syncHexUi();
  render();
})();

const options = () => ({
  ignoreWhitespace: prefs.ignoreWhitespace,
  ignoreCase: prefs.ignoreCase,
  ignoreBlank: prefs.ignoreBlank,
});

function syncOptionButtons() {
  const map = {
    "opt-inline": prefs.inline,
    "opt-ws": prefs.ignoreWhitespace,
    "opt-case": prefs.ignoreCase,
    "opt-blank": prefs.ignoreBlank,
    "opt-json": prefs.jsonNormalize,
  };
  for (const [id, on] of Object.entries(map)) $(id).setAttribute("aria-pressed", String(!!on));
  $("view-split").setAttribute("aria-pressed", String(view === "split"));
  $("view-unified").setAttribute("aria-pressed", String(view === "unified"));
}

function persistPrefs() {
  void kit.save(PREF_KEY, prefs).catch(() => {});
}

function syncHexUi() {
  $("result-mode").textContent = hexMode ? "hex 字节对比" : "行级";
}

/* ── 渲染 ─────────────────────────── */
function render() {
  let a = $("source").value;
  let b = $("target").value;
  const viewEl = $("diff-view");
  ops = [];
  currentChange = -1;
  jsonNotice = "";
  viewEl.classList.toggle("hex", hexMode);
  viewEl.classList.toggle("unified", view === "unified" && !hexMode);

  if (!a && !b) {
    viewEl.innerHTML =
      '<div class="diff-empty">在两侧粘贴文本开始对比；也可以把本地文件拖到任意一侧。<br>选项支持字符级细化 / 忽略空白 / 忽略大小写 / 忽略空行；JSON 规范化会按键排序后对比；统一视图切换单栏差异流。</div>';
    $("stats").innerHTML = "";
    $("nav-pos").hidden = true;
    for (const id of ["nav-prev", "nav-next", "copy-diff", "export-diff"]) $(id).disabled = true;
    return;
  }

  if (hexMode) {
    renderHex(a, b);
  } else {
    // JSON 规范化：两侧都解析成功才启用，否则原文对比并提示
    if (prefs.jsonNormalize) {
      const pair = normalizeJsonPair(a, b);
      if (pair) {
        a = pair.a;
        b = pair.b;
      } else {
        jsonNotice = "JSON 规范化未生效：至少一侧不是合法 JSON，已按原文对比";
      }
    }
    renderLines(a, b);
  }
  renderNotice();
  syncStats();
  updateNav();
}

function renderNotice() {
  const old = $("diff-notice");
  if (old) old.remove();
  if (!jsonNotice) return;
  const bar = document.createElement("div");
  bar.className = "diff-notice";
  bar.id = "diff-notice";
  bar.textContent = jsonNotice;
  $("diff-view").before(bar);
}

function renderLines(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const script = diffLines(a, b, options());
  const counts = countChanges(script);
  const viewEl = $("diff-view");
  const hunks = pairHunks(script);
  const unified = view === "unified";
  const inline = prefs.inline;
  const frag = document.createDocumentFragment();
  const buildRow = (cls, cells) => {
    const row = document.createElement("div");
    row.className = "diff-row" + (cls ? " " + cls : "");
    for (const cell of cells) {
      const span = document.createElement("span");
      span.className = cell.cls;
      span.innerHTML = cell.html ?? "";
      row.appendChild(span);
    }
    frag.appendChild(row);
    return row;
  };
  // 并排四列 / 统一四列（符号 + 双行号 + 文本）
  const splitRow = (cls, aNo, aHtml, bNo, bHtml) =>
    buildRow(cls, [
      { cls: "gutter", html: aNo ? esc(aNo) : "" },
      { cls: "cell", html: aHtml ?? "" },
      { cls: "gutter", html: bNo ? esc(bNo) : "" },
      { cls: "cell", html: bHtml ?? "" },
    ]);
  const unifiedRow = (cls, sign, aNo, bNo, html) =>
    buildRow(cls, [
      { cls: "sign", html: sign },
      { cls: "gutter", html: aNo ? esc(aNo) : "" },
      { cls: "gutter", html: bNo ? esc(bNo) : "" },
      { cls: "cell", html },
    ]);
  const register = (row) => {
    row.dataset.change = String(ops.length);
    ops.push({ el: row, change: ops.length });
  };
  const inlineSegs = (aText, bText) => {
    const segs = diffChars(aText, bText);
    return {
      left: segs
        .filter((s) => s.kind !== "ins")
        .map((s) => (s.kind === "del" ? `<del>${esc(s.value)}</del>` : esc(s.value)))
        .join(""),
      right: segs
        .filter((s) => s.kind !== "del")
        .map((s) => (s.kind === "ins" ? `<ins>${esc(s.value)}</ins>` : esc(s.value)))
        .join(""),
    };
  };

  for (const hunk of hunks) {
    if (hunk.type === "same") {
      const text = esc(aLines[hunk.line.aIndex] ?? "");
      if (unified) unifiedRow("", "&nbsp;", hunk.line.aIndex + 1, hunk.line.bIndex + 1, text);
      else splitRow("", hunk.line.aIndex + 1, text, hunk.line.bIndex + 1, text);
    } else if (hunk.type === "del-only") {
      for (const d of hunk.dels) {
        const row = unified
          ? unifiedRow("del", "−", d.aIndex + 1, "", esc(aLines[d.aIndex] ?? ""))
          : splitRow("del", d.aIndex + 1, esc(aLines[d.aIndex] ?? ""), "", "");
        register(row);
      }
    } else if (hunk.type === "add-only") {
      for (const ad of hunk.adds) {
        const row = unified
          ? unifiedRow("add", "+", "", ad.bIndex + 1, esc(bLines[ad.bIndex] ?? ""))
          : splitRow("add", "", "", ad.bIndex + 1, esc(bLines[ad.bIndex] ?? ""));
        register(row);
      }
    } else {
      // change：可选行内字符细化
      const pairs = Math.max(hunk.dels.length, hunk.adds.length);
      for (let p = 0; p < pairs; p++) {
        const d = hunk.dels[p];
        const ad = hunk.adds[p];
        const aText = d ? (aLines[d.aIndex] ?? "") : "";
        const bText = ad ? (bLines[ad.bIndex] ?? "") : "";
        let left = d ? esc(aText) : "";
        let right = ad ? esc(bText) : "";
        if (inline && d && ad) {
          const segs = inlineSegs(aText, bText);
          left = segs.left;
          right = segs.right;
        }
        let row;
        if (unified) {
          if (d) row = register(unifiedRow("del", "−", d.aIndex + 1, "", left));
          if (ad) row = register(unifiedRow("add", "+", "", ad.bIndex + 1, right));
        } else {
          row = splitRow(d && ad ? "del add" : d ? "del" : "add", d ? d.aIndex + 1 : "", d ? left : "", ad ? ad.bIndex + 1 : "", ad ? right : "");
          register(row);
        }
      }
    }
  }
  viewEl.replaceChildren(frag);
  void counts;
}

function renderHex(a, b) {
  const dumpA = hexDump(a);
  const dumpB = hexDump(b);
  const linesA = dumpA ? dumpA.split("\n") : [];
  const linesB = dumpB ? dumpB.split("\n") : [];
  const rows = Math.max(linesA.length, linesB.length);
  const viewEl = $("diff-view");
  const frag = document.createDocumentFragment();
  let changeIndex = 0;
  for (let i = 0; i < rows; i++) {
    const la = linesA[i] ?? "";
    const lb = linesB[i] ?? "";
    const same = la === lb;
    const row = document.createElement("div");
    row.className =
      "diff-row hex-line " + (same ? "" : la && !lb ? "del" : lb && !la ? "add" : la !== lb ? "del add" : "");
    if (!same) row.dataset.change = String(changeIndex++);
    row.innerHTML =
      `<span class="gutter">${i + 1}</span><span class="cell">${esc(la)}</span>` +
      `<span class="gutter">${i + 1}</span><span class="cell">${esc(lb)}</span>`;
    frag.appendChild(row);
    ops.push({ el: row, change: same ? -1 : changeIndex - 1 });
  }
  viewEl.replaceChildren(frag);
}

function syncStats() {
  const stats = $("stats");
  if (hexMode) {
    const diffRows = ops.filter((o) => o.change >= 0).length;
    stats.innerHTML = diffRows
      ? `<span class="del">${diffRows} 行不同</span>`
      : '<span class="add">字节完全一致</span>';
    $("copy-diff").disabled = $("export-diff").disabled = true;
    return;
  }
  let a = $("source").value;
  let b = $("target").value;
  if (prefs.jsonNormalize) {
    const pair = normalizeJsonPair(a, b);
    if (pair) {
      a = pair.a;
      b = pair.b;
    }
  }
  const counts = countChanges(diffLines(a, b, options()));
  const sameCounts = !counts.adds && !counts.dels;
  stats.innerHTML = sameCounts
    ? '<span class="same">两栏一致</span>'
    : `<span class="add">+${counts.adds}</span><span class="del">−${counts.dels}</span>`;
  $("copy-diff").disabled = $("export-diff").disabled = sameCounts;
}

/* ── 导航 ─────────────────────────── */
function changeRows() {
  return ops.filter((o) => o.change >= 0);
}
function updateNav() {
  const rows = changeRows();
  $("nav-prev").disabled = $("nav-next").disabled = !rows.length;
  const pos = $("nav-pos");
  if (!rows.length) {
    pos.hidden = true;
    currentChange = -1;
    return;
  }
  if (currentChange < 0) currentChange = 0;
  pos.hidden = false;
  pos.textContent = `${currentChange + 1} / ${rows.length} 处`;
}
function jump(step) {
  const rows = changeRows();
  if (!rows.length) return;
  currentChange = (currentChange + step + rows.length) % rows.length;
  const target = rows[currentChange].el;
  for (const row of $("diff-view").querySelectorAll(".diff-row.current")) row.classList.remove("current");
  target.classList.add("current");
  target.scrollIntoView({ block: "center" });
  $("nav-pos").textContent = `${currentChange + 1} / ${rows.length} 处`;
}

/* ── 导出 ─────────────────────────── */
function diffText() {
  let a = $("source").value;
  let b = $("target").value;
  if (prefs.jsonNormalize) {
    const pair = normalizeJsonPair(a, b);
    if (pair) {
      a = pair.a;
      b = pair.b;
    }
  }
  return unifiedDiff(a, b, { options: options() });
}

/* ── 事件 ─────────────────────────── */
let debounce;
const scheduleRender = () => {
  clearTimeout(debounce);
  debounce = setTimeout(render, 200);
};
$("source").addEventListener("input", scheduleRender);
$("target").addEventListener("input", scheduleRender);

for (const [id, key] of [
  ["opt-inline", "inline"],
  ["opt-ws", "ignoreWhitespace"],
  ["opt-case", "ignoreCase"],
  ["opt-blank", "ignoreBlank"],
  ["opt-json", "jsonNormalize"],
]) {
  $(id).addEventListener("click", () => {
    prefs[key] = !prefs[key];
    persistPrefs();
    render();
  });
}
$("view-split").addEventListener("click", () => {
  view = "split";
  syncOptionButtons();
  render();
});
$("view-unified").addEventListener("click", () => {
  view = "unified";
  syncOptionButtons();
  render();
});
$("nav-prev").onclick = () => jump(-1);
$("nav-next").onclick = () => jump(1);
// 差异导航：Ctrl/⌘+↑↓（编辑器内不拦截光标移动；Alt+↑↓ 备选）
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const nav = e.metaKey || e.ctrlKey || e.altKey;
  if (!nav) return;
  const inEditor = ["TEXTAREA", "INPUT"].includes(e.target.tagName);
  if (inEditor && !(e.altKey && !e.metaKey && !e.ctrlKey)) return; // 编辑器内仅 Alt 组合生效
  e.preventDefault();
  jump(e.key === "ArrowDown" ? 1 : -1);
});
$("swap").onclick = () => {
  const a = $("source").value;
  $("source").value = $("target").value;
  $("target").value = a;
  render();
};
$("copy-diff").onclick = () => {
  const text = diffText();
  if (!text) {
    kit.toast("两栏内容一致，没有可复制的差异");
    return;
  }
  kit.copy(text).catch((e) => kit.toast(e.message, "error"));
};
$("export-diff").onclick = () => {
  const text = diffText();
  if (!text) {
    kit.toast("两栏内容一致，没有可导出的差异");
    return;
  }
  kit.saveText("diff.patch", text + "\n").catch((e) => kit.toast(e.message, "error"));
};
for (const [btn, area] of [
  ["paste-source", "source"],
  ["paste-target", "target"],
]) {
  $(btn).onclick = async () => {
    try {
      const text = await api.clipboard.readText();
      $(area).value = String(text ?? "");
      render();
    } catch (e) {
      kit.toast(e.message, "error");
    }
  };
}
for (const [btn, area] of [
  ["clear-source", "source"],
  ["clear-target", "target"],
]) {
  $(btn).onclick = () => {
    $(area).value = "";
    render();
    $(area).focus();
  };
}

/* hex 模式开关：⌘/Ctrl+Shift+H 或双击结果标题 */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "h") {
    e.preventDefault();
    toggleHex();
  }
});
$("result-mode").addEventListener("dblclick", toggleHex);
async function toggleHex() {
  hexMode = !hexMode;
  syncHexUi();
  try {
    await kit.save(HEX_KEY, hexMode);
  } catch {
    /* 持久化失败不阻塞 */
  }
  render();
  kit.toast(hexMode ? "已切换 hex 字节对比" : "已切回行级对比");
}

/* ── 拖入 / 选择文件（经宿主 localFiles 句柄，零额外权限） ─────────────────────────── */
async function readFileToArea(file, area) {
  if (file.size > 2 * 1024 * 1024) {
    kit.toast("文件超过 2MB，请粘贴文本片段", "error");
    return;
  }
  try {
    area.value = await file.text();
    render();
    kit.toast(`已载入 ${file.name}`, "success");
  } catch (e) {
    kit.toast(e.message, "error");
  }
}
for (const [wrapId, areaId] of [
  ["source-drop", "source"],
  ["target-drop", "target"],
]) {
  const wrap = $(wrapId);
  const area = $(areaId);
  wrap.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      wrap.classList.add("dragover");
      wrap.querySelector(".drop-hint").hidden = false;
    }
  });
  wrap.addEventListener("dragleave", () => {
    wrap.classList.remove("dragover");
    wrap.querySelector(".drop-hint").hidden = true;
  });
  wrap.addEventListener("drop", async (e) => {
    wrap.classList.remove("dragover");
    wrap.querySelector(".drop-hint").hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    await readFileToArea(file, area);
  });
}
for (const [btnId, areaId] of [
  ["pick-source", "source"],
  ["pick-target", "target"],
]) {
  $(btnId).addEventListener("click", () => {
    api.localFiles
      .pick({ kind: "file", access: "read" })
      .then(async (handles) => {
        const handle = handles?.[0];
        if (!handle) return;
        const file = await api.localFiles.read({ handleId: handle.id, encoding: "text", maxBytes: 2 * 1024 * 1024 });
        $(areaId).value = String(file ?? "");
        render();
        kit.toast(`已载入 ${handle.name}`, "success");
      })
      .catch((error) => kit.toast(error.message, "error"));
  });
}

render();
