import { diffLines, countChanges, pairHunks, diffChars, unifiedDiff, hexDump } from "./core.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const esc = PluginKit.escape;

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

const HEX_KEY = "diff_hex_mode_v1";
let ops = []; // 渲染行模型：{ el, changeIndex? }
let currentChange = -1;
let changeCount = 0;
let hexMode = false;

(async () => {
  await kit.ready;
  $("opt-inline").setAttribute("aria-pressed", String(!!kit.settings.inline));
  $("opt-ws").setAttribute("aria-pressed", String(!!kit.settings.ignoreWhitespace));
  $("opt-case").setAttribute("aria-pressed", String(!!kit.settings.ignoreCase));
  hexMode = !!(await kit.load(HEX_KEY, false));
  syncHexUi();
  render();
})();

const options = () => ({
  ignoreWhitespace: $("opt-ws").getAttribute("aria-pressed") === "true",
  ignoreCase: $("opt-case").getAttribute("aria-pressed") === "true",
});
const inlineEnabled = () => $("opt-inline").getAttribute("aria-pressed") === "true";

function syncHexUi() {
  $("result-mode").textContent = hexMode ? "hex 字节对比" : "行级";
}

/* ── 渲染 ─────────────────────────── */
function render() {
  const a = $("source").value;
  const b = $("target").value;
  const view = $("diff-view");
  ops = [];
  changeCount = 0;
  currentChange = -1;
  view.classList.toggle("hex", hexMode);

  if (!a && !b) {
    view.innerHTML =
      '<div class="diff-empty">在两侧粘贴文本开始对比；也可以把本地文件拖到任意一侧。<br>选项支持忽略空白 / 忽略大小写 / 行内字符细化，hex 模式按字节 dump 对比。</div>';
    $("stats").innerHTML = "";
    $("nav-prev").disabled = $("nav-next").disabled = $("export-diff").disabled = true;
    return;
  }

  if (hexMode) {
    renderHex(a, b);
  } else {
    renderLines(a, b);
  }
  syncStats();
  updateNav();
}

function renderLines(a, b) {
  const script = diffLines(a, b, options());
  const counts = countChanges(script);
  changeCount = counts.dels + counts.adds;
  const view = $("diff-view");
  const hunks = pairHunks(script);
  let html = "";
  let aNo = 0;
  let bNo = 0;
  const inline = inlineEnabled();
  const frag = document.createDocumentFragment();
  let idx = 0;
  let changeIndexCounter = 0;
  const buildRow = (cls, gutterA, cellA, gutterB, cellB) => {
    const row = document.createElement("div");
    row.className = "diff-row " + cls;
    row.innerHTML =
      `<span class="gutter">${gutterA ?? ""}</span><span class="cell">${cellA ?? ""}</span>` +
      `<span class="gutter">${gutterB ?? ""}</span><span class="cell">${cellB ?? ""}</span>`;
    frag.appendChild(row);
    return row;
  };
  for (const hunk of hunks) {
    if (hunk.type === "same") {
      aNo++;
      bNo++;
      const row = buildRow("", aNo, esc(textAt(a, hunk.line.aIndex)), bNo, esc(textAt(b, hunk.line.bIndex)));
      ops.push({ el: row, change: -1 });
    } else if (hunk.type === "del-only") {
      for (const d of hunk.dels) {
        aNo++;
        const row = buildRow("del", aNo, esc(textAt(a, d.aIndex)), "", "");
        row.dataset.change = String(changeIndexCounter++);
        ops.push({ el: row, change: changeIndexCounter - 1 });
      }
    } else if (hunk.type === "add-only") {
      for (const ad of hunk.adds) {
        bNo++;
        const row = buildRow("add", "", "", bNo, esc(textAt(b, ad.bIndex)));
        row.dataset.change = String(changeIndexCounter++);
        ops.push({ el: row, change: changeIndexCounter - 1 });
      }
    } else {
      // change：可选行内细化
      const pairs = Math.max(hunk.dels.length, hunk.adds.length);
      for (let p = 0; p < pairs; p++) {
        const d = hunk.dels[p];
        const ad = hunk.adds[p];
        let leftHtml = "",
          rightHtml = "";
        if (d) {
          aNo++;
          leftHtml = esc(textAt(a, d.aIndex));
        }
        if (ad) {
          bNo++;
          rightHtml = esc(textAt(b, ad.bIndex));
        }
        if (inline && d && ad) {
          const segs = diffChars(textAt(a, d.aIndex), textAt(b, ad.bIndex));
          leftHtml = segs
            .filter((s) => s.kind !== "ins")
            .map((s) => (s.kind === "del" ? `<del>${esc(s.value)}</del>` : esc(s.value)))
            .join("");
          rightHtml = segs
            .filter((s) => s.kind !== "del")
            .map((s) => (s.kind === "ins" ? `<ins>${esc(s.value)}</ins>` : esc(s.value)))
            .join("");
        }
        const row = buildRow(
          d && ad ? "del add" : d ? "del" : "add",
          d ? aNo : "",
          d ? leftHtml : "",
          ad ? bNo : "",
          ad ? rightHtml : "",
        );
        row.dataset.change = String(changeIndexCounter++);
        ops.push({ el: row, change: changeIndexCounter - 1 });
      }
    }
  }
  void idx;
  view.innerHTML = "";
  view.appendChild(frag);
}

function textAt(text, index) {
  return String(text ?? "").split("\n")[index] ?? "";
}

function renderHex(a, b) {
  const dumpA = hexDump(a);
  const dumpB = hexDump(b);
  const linesA = dumpA ? dumpA.split("\n") : [];
  const linesB = dumpB ? dumpB.split("\n") : [];
  const rows = Math.max(linesA.length, linesB.length);
  const view = $("diff-view");
  changeCount = Math.abs(linesA.length - linesB.length);
  const frag = document.createDocumentFragment();
  let changeIndex = 0;
  for (let i = 0; i < rows; i++) {
    const la = linesA[i] ?? "";
    const lb = linesB[i] ?? "";
    const same = la === lb;
    const row = document.createElement("div");
    row.className = "diff-row hex-line " + (same ? "" : la && !lb ? "del" : lb && !la ? "add" : la !== lb ? "del add" : "");
    if (!same) row.dataset.change = String(changeIndex++);
    row.innerHTML =
      `<span class="gutter">${i + 1}</span><span class="cell">${esc(la)}</span>` +
      `<span class="gutter">${i + 1}</span><span class="cell">${esc(lb)}</span>`;
    frag.appendChild(row);
    ops.push({ el: row, change: same ? -1 : changeIndex - 1 });
  }
  view.innerHTML = "";
  view.appendChild(frag);
}

function syncStats() {
  const stats = $("stats");
  if (hexMode) {
    const diffRows = ops.filter((o) => o.change >= 0).length;
    stats.innerHTML = diffRows
      ? `<span class="del">${diffRows} 行不同</span>`
      : '<span class="add">字节完全一致</span>';
    $("export-diff").disabled = true;
    return;
  }
  const a = $("source").value;
  const b = $("target").value;
  const counts = countChanges(diffLines(a, b, options()));
  stats.innerHTML =
    `<span class="add">+${counts.adds}</span><span class="del">−${counts.dels}</span>`;
  $("export-diff").disabled = !(counts.adds || counts.dels);
}

/* ── 导航 ─────────────────────────── */
function changeRows() {
  return ops.filter((o) => o.change >= 0);
}
function updateNav() {
  const rows = changeRows();
  $("nav-prev").disabled = $("nav-next").disabled = !rows.length;
}
function jump(step) {
  const rows = changeRows();
  if (!rows.length) return;
  currentChange = (currentChange + step + rows.length) % rows.length;
  const target = rows[currentChange].el;
  for (const row of view().querySelectorAll(".diff-row.current")) row.classList.remove("current");
  target.classList.add("current");
  target.scrollIntoView({ block: "center" });
}
function view() {
  return $("diff-view");
}

/* ── 事件 ─────────────────────────── */
let debounce;
const scheduleRender = () => {
  clearTimeout(debounce);
  debounce = setTimeout(render, 200);
};
$("source").addEventListener("input", scheduleRender);
$("target").addEventListener("input", scheduleRender);
for (const id of ["opt-inline", "opt-ws", "opt-case"]) {
  $(id).addEventListener("click", () => {
    const b = $(id);
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    render();
  });
}
$("nav-prev").onclick = () => jump(-1);
$("nav-next").onclick = () => jump(1);
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const inEditor = ["TEXTAREA", "INPUT"].includes(e.target.tagName);
  if (inEditor) return; // 不拦截编辑器内的光标移动
  e.preventDefault();
  jump(e.key === "ArrowDown" ? 1 : -1);
});
$("swap").onclick = () => {
  const a = $("source").value;
  $("source").value = $("target").value;
  $("target").value = a;
  render();
};
$("export-diff").onclick = () => {
  const text = unifiedDiff($("source").value, $("target").value, { options: options() });
  if (!text) {
    kit.toast("两栏内容一致，没有可导出的差异");
    return;
  }
  kit.copy(text).catch((e) => kit.toast(e.message, "error"));
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

/* ── 拖入文件（DOM File API，零额外权限） ─────────────────────────── */
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
    if (file.size > 2 * 1024 * 1024) {
      kit.toast("文件超过 2MB，请粘贴文本片段", "error");
      return;
    }
    try {
      area.value = await file.text();
      render();
      kit.toast(`已载入 ${file.name}`, "success");
    } catch (e2) {
      kit.toast(e2.message, "error");
    }
  });
}

render();
