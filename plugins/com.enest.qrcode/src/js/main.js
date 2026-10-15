import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
import { templateText, qrSvg, decodedType, commitHistory, drawModules, logoFit, DOT_STYLES } from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let generated = null,
  history = [],
  timer,
  decoded = [],
  decodeToken = 0,
  batchToken = 0,
  batch = [];
const kit = PluginKit.create({
  title: "二维码",
  quickPlaceholder: "输入文本或 URL 生成二维码",
  height: 480,
  defaults: {
    defaultSize: "256",
    defaultEcc: "M",
    foreground: "#000000",
    background: "#ffffff",
  },
  onQuery(text) {
    $("template").value = "text";
    template();
    $("input").value = text;
    PluginKit.upgradeSelects(); // 同步自定义下拉选中标签
    generate();
  },
  onAction(action) {
    if (action === "submit") copyImage();
    else if (action === "clear") {
      $("input").value = "";
      generate();
    }
  },
});
const safe =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      kit.toast(e.message, "error");
    }
  };

// ---------- 样式选项（点样式 + 中心 logo），持久化于 storage.local ----------
const STYLE_KEY = "qrcode_style_v1";
let dotStyle = "square",
  logoDataUrl = "",
  logoScale = 20;
function saveStyle() {
  const data = { dotStyle, logoDataUrl: logoDataUrl.slice(0, 60000), logoScale };
  return kit.save(STYLE_KEY, data).catch(() => {});
}
async function loadStyle() {
  try {
    const saved = await kit.load(STYLE_KEY, null);
    if (!saved || typeof saved !== "object") return;
    if (DOT_STYLES.some((s) => s.id === saved.dotStyle)) dotStyle = saved.dotStyle;
    if (typeof saved.logoDataUrl === "string" && saved.logoDataUrl.startsWith("data:image/")) logoDataUrl = saved.logoDataUrl;
    if (Number.isFinite(saved.logoScale)) logoScale = Math.max(0, Math.min(30, saved.logoScale));
  } catch {
    /* 首次运行无样式记录 */
  }
  syncStyleControls();
}
function syncStyleControls() {
  document.querySelectorAll("[data-dot]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.dot === dotStyle)));
  $("logo-scale").value = String(logoScale);
  $("logo-scale-value").value = `${logoScale}%`;
  $("logo-clear").disabled = !logoDataUrl;
  $("logo-status").textContent = logoDataUrl ? "已加载 logo" : "未设置";
}

function options() {
  return {
    size: Number($("size").value),
    ecc: $("ecc").value,
    fg: $("fg").value,
    bg: $("bg").value,
    style: dotStyle,
  };
}
function payload() {
  const type = $("template").value;
  return templateText(
    type,
    type === "wifi"
      ? {
          ssid: $("wifi-ssid").value,
          password: $("wifi-password").value,
          security: $("wifi-security").value,
          hidden: $("wifi-hidden").checked,
        }
      : type === "contact"
        ? {
            name: $("contact-name").value,
            phone: $("contact-phone").value,
            email: $("contact-email").value,
            company: $("contact-company").value,
          }
        : type === "email"
          ? {
              email: $("email-to").value,
              subject: $("email-subject").value,
              body: $("email-body").value,
            }
          : { text: $("input").value },
  );
}
function makeQr(text, opts) {
  window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"];
  const qr = window.qrcode(0, opts.ecc);
  qr.addData(text);
  qr.make();
  return qr;
}
function draw(canvas, qr, opts) {
  const count = qr.getModuleCount(),
    scale = Math.max(1, Math.floor(opts.size / (count + 8))),
    size = (count + 8) * scale;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = opts.fg;
  drawModules(ctx, qr, { scale, margin: 4, style: opts.style || "square" });
  if (logoDataUrl) drawLogo(ctx, qr, opts, size);
}
function drawLogo(ctx, qr, opts, size) {
  const fit = logoFit(qr, logoScale / 100, opts.ecc);
  if (!fit.ok) return; // logo 不安全时静默跳过（状态由 meta 区提示）
  const box = size * (logoScale / 100);
  const x = (size - box) / 2,
    y = (size - box) / 2;
  const pad = Math.max(3, Math.round(box * 0.08));
  ctx.fillStyle = opts.bg;
  ctx.beginPath();
  ctx.roundRect(x - pad, y - pad, box + pad * 2, box + pad * 2, Math.round(box * 0.18));
  ctx.fill();
  if (!logoImage) return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, box, box, Math.round(box * 0.14));
  ctx.clip();
  ctx.drawImage(logoImage, x, y, box, box);
  ctx.restore();
}
let logoImage = null;
function loadLogoImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("logo 图片无法读取"));
    image.src = dataUrl;
  });
}
function template() {
  document.querySelectorAll("[data-template]").forEach((el) => {
    el.hidden = el.dataset.template !== $("template").value;
  });
  $("wifi-password").disabled = $("wifi-security").value === "nopass";
  generate();
}
function generate() {
  clearTimeout(timer);
  generated = null;
  $("error").textContent = "";
  $("canvas").classList.remove("ready");
  $("empty").hidden = false;
  $("meta").textContent = "";
  for (const id of ["copy-image", "save-png", "save-svg"]) $(id).disabled = true;
  try {
    const text = payload();
    if (!text.trim()) return;
    const opts = options(),
      qr = makeQr(text, opts);
    let logoWarning = "";
    if (logoDataUrl) {
      const fit = logoFit(qr, logoScale / 100, opts.ecc);
      if (!fit.ok) logoWarning = ` · logo 未叠加：${fit.reason}`;
    }
    draw($("canvas"), qr, opts);
    generated = { text, ...opts, qr };
    $("canvas").classList.add("ready");
    $("empty").hidden = true;
    $("meta").textContent =
      `${text.length} 字符 · ${qr.getModuleCount()}×${qr.getModuleCount()} 模块 · ${$("canvas").width}px${logoWarning}`;
    for (const id of ["copy-image", "save-png", "save-svg"]) $(id).disabled = false;
  } catch (e) {
    $("error").textContent = "生成失败：" + e.message;
  }
}
// ---------- 历史记录：持久化（最近 12 条，向后兼容会话内结构） ----------
const HISTORY_KEY = "qrcode_history_v1";
async function loadHistory() {
  try {
    const saved = await kit.load(HISTORY_KEY, null);
    if (Array.isArray(saved)) history = saved.filter((item) => item && typeof item.text === "string").slice(0, 12);
  } catch {
    /* 忽略 */
  }
  renderHistory();
}
function remember() {
  if (!generated) return;
  const { qr, ...entry } = generated;
  history = commitHistory(history, entry);
  renderHistory();
  void kit.save(HISTORY_KEY, history).catch(() => {});
}
function renderHistory() {
  $("history").replaceChildren();
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "复制或保存后，最近 12 条记录会留在这里。";
    $("history").append(empty);
    return;
  }
  for (const item of history) {
    const b = document.createElement("button");
    b.textContent = item.text;
    b.title = "恢复内容";
    b.onclick = () => {
      $("template").value = "text";
      $("input").value = item.text;
      $("size").value = item.size;
      $("ecc").value = item.ecc;
      $("fg").value = item.fg;
      $("bg").value = item.bg;
      PluginKit.upgradeSelects(); // 恢复历史后同步下拉标签
      template();
    };
    $("history").append(b);
  }
}
const copyImage = safe(async () => {
  if (!generated) return;
  await api.clipboard.writeImage($("canvas").toDataURL("image/png"));
  remember();
  kit.toast("已复制二维码图片", "success");
});
$("copy-image").onclick = copyImage;
$("save-png").onclick = safe(async () => {
  if (!generated) return;
  const size = Number($("png-size").value) || generated.size;
  const offscreen = document.createElement("canvas");
  const qr = makeQr(generated.text, generated);
  draw(offscreen, qr, { ...generated, size });
  if ((await kit.saveFile(`qrcode-${size}.png`, offscreen.toDataURL("image/png"))).ok) remember();
});
$("save-svg").onclick = safe(async () => {
  if (generated && (await kit.saveText("qrcode.svg", qrSvg(generated.qr, generated)))?.ok) remember();
});
$("template").onchange = template;
for (const el of document.querySelectorAll(
  ".composer input,.composer textarea,.composer select",
))
  if (el.id !== "template")
    el.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(generate, 240);
    });
// 自定义下拉（PluginKit.upgradeSelects）只派发 change 不派发 input，
// select 需单独监听 change 才能在改尺寸/纠错/加密后触发生成
for (const el of document.querySelectorAll(".composer select"))
  if (el.id !== "template")
    el.addEventListener("change", () => {
      clearTimeout(timer);
      generate();
    });
$("paste-text").onclick = safe(async () => {
  $("template").value = "text";
  $("input").value = await api.clipboard.readText();
  PluginKit.upgradeSelects(); // 同步自定义下拉选中标签
  template();
});
// ---------- 样式定制接线（点样式分段控件在底部 DOT_STYLES 注入后统一绑定） ----------
$("logo-scale").oninput = () => {
  logoScale = Number($("logo-scale").value) || 20;
  $("logo-scale-value").value = `${logoScale}%`;
  generate();
};
$("logo-scale").onchange = () => void saveStyle();
$("logo-file").onchange = () =>
  void safe(async () => {
    const file = $("logo-file").files[0];
    $("logo-file").value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) throw new Error("logo 需为图片文件");
    if (file.size > 1024 * 1024) throw new Error("logo 图片需小于 1 MB");
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("logo 读取失败"));
      reader.readAsDataURL(file);
    });
    logoImage = await loadLogoImage(dataUrl);
    logoDataUrl = dataUrl;
    syncStyleControls();
    generate();
    void saveStyle();
  });
$("logo-clear").onclick = () => {
  logoDataUrl = "";
  logoImage = null;
  syncStyleControls();
  generate();
  void saveStyle();
};
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
document.querySelectorAll("[data-tab]").forEach((b) => {
  b.onclick = () => tab(b.dataset.tab);
});
function readFile(file) {
  if (!file.type.startsWith("image/"))
    return Promise.reject(new Error("仅支持图片文件"));
  if (file.size > 20 * 1024 * 1024)
    return Promise.reject(new Error("单张图片不能超过 20 MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("图片加载失败"));
    image.onload = () => {
      try {
        const ratio = Math.min(
          1,
          2200 / Math.max(image.naturalWidth, image.naturalHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(data.data, canvas.width, canvas.height, {
          inversionAttempts: "attemptBoth",
        });
        canvas.width = canvas.height = 0;
        if (!code) reject(new Error("未识别到二维码，请尝试裁剪后重试"));
        else resolve(code.data);
      } catch (e) {
        reject(e);
      }
    };
    image.src = dataUrl;
  });
}
function renderDecoded() {
  $("decoded-list").replaceChildren();
  for (const item of decoded) {
    const row = document.createElement("article");
    row.className = "decoded-row";
    const image = document.createElement("img");
    image.alt = item.name;
    if (item.dataUrl) image.src = item.dataUrl;
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const type = document.createElement("small");
    const info = item.ok ? decodedType(item.text) : { label: "识别失败" };
    type.textContent = " · " + info.label;
    const pre = document.createElement("pre");
    pre.textContent = item.text;
    if (!item.ok) pre.className = "decode-error";
    body.append(title, type, pre);
    const actions = document.createElement("div");
    actions.className = "decoded-actions";
    if (item.ok) {
      const copy = document.createElement("button");
      copy.textContent = "复制";
      copy.onclick = safe(() => kit.copy(item.text));
      actions.append(copy);
      if (info.url) {
        const open = document.createElement("button");
        open.textContent = "打开链接";
        open.onclick = safe(() => api.shell.openExternal(info.url));
        actions.append(open);
      }
    }
    row.append(image, body, actions);
    $("decoded-list").append(row);
  }
}
async function processImages(items) {
  const token = ++decodeToken;
  decoded = [];
  renderDecoded();
  if (items.length > 30) {
    $("decode-status").textContent = "每批最多 30 张图片";
    return;
  }
  for (let i = 0; i < items.length; i++) {
    if (token !== decodeToken) return;
    $("decode-status").textContent = `正在识别 ${i + 1}/${items.length}`;
    let dataUrl = "";
    try {
      dataUrl = items[i].dataUrl || (await readFile(items[i].file));
      if (dataUrl.length > 28 * 1024 * 1024)
        throw new Error("单张图片不能超过 20 MB");
      const text = await decodeImage(dataUrl);
      if (token !== decodeToken) return;
      decoded.push({ name: items[i].name, dataUrl, text, ok: true });
    } catch (e) {
      if (token !== decodeToken) return;
      decoded.push({
        name: items[i].name,
        dataUrl,
        text: e.message,
        ok: false,
      });
    }
    renderDecoded();
    await new Promise(requestAnimationFrame);
  }
  $("decode-status").textContent =
    `${decoded.filter((v) => v.ok).length}/${items.length} 张识别成功`;
}
  bindFileInput(document.getElementById('files'), { api, onError: error => kit.toast(error.message, 'error') })
$("choose-files").onclick = (event) => {
  event.stopPropagation();
  $("files").click();
};
$("files").onchange = () => {
  const files = [...$("files").files];
  $("files").value = "";
  processImages(files.map((file) => ({ file, name: file.name })));
};
$("paste-image").onclick = safe(async (event) => {
  event?.stopPropagation();
  const image = await api.clipboard.readImage();
  if (!image?.dataUrl) return kit.toast("剪贴板中没有图片", "info");
  await processImages([{ name: "剪贴板图片", dataUrl: image.dataUrl }]);
});
$("drop-zone").onclick = (e) => {
  if (e.target.closest("button,input")) return;
  $("files").click();
};
$("drop-zone").onkeydown = (e) => {
  if (e.target === $("drop-zone") && ["Enter", " "].includes(e.key)) {
    e.preventDefault();
    $("files").click();
  }
};
$("drop-zone").ondragover = (e) => {
  e.preventDefault();
  $("drop-zone").classList.add("dragging");
};
$("drop-zone").ondragleave = () => $("drop-zone").classList.remove("dragging");
$("drop-zone").ondrop = safe(async (e) => {
  e.preventDefault();
  $("drop-zone").classList.remove("dragging");
  await processImages(
    (await readDroppedFiles(e.dataTransfer.files, { api })).map((file) => ({ file, name: file.name })),
  );
});
$("copy-decoded").onclick = safe(() =>
  kit.copy(
    decoded
      .filter((r) => r.ok)
      .map((r) => r.text)
      .join("\n"),
  ),
);
$("export-decoded").onclick = safe(() =>
  kit.saveText(
    "decoded.tsv",
    "文件\t状态\t内容\n" +
      decoded
        .map((r) =>
          [r.name, r.ok ? "成功" : "失败", r.text]
            .map((s) => JSON.stringify(s))
            .join("\t"),
        )
        .join("\n"),
  ),
);
$("clear-decoded").onclick = () => {
  decodeToken++;
  decoded = [];
  renderDecoded();
  $("decode-status").textContent = "";
};
$("batch-run").onclick = safe(async () => {
  const lines = $("batch-input")
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length > 50) throw new Error("每批最多 50 项");
  const token = ++batchToken,
    opts = options();
  batch = [];
  $("batch-grid").replaceChildren();
  $("batch-save").disabled = true;
  for (let i = 0; i < lines.length; i++) {
    if (token !== batchToken) return;
    const card = document.createElement("article");
    card.className = "batch-card";
    try {
      const qr = makeQr(lines[i], opts),
        svg = qrSvg(qr, opts);
      const entry = { text: lines[i], svg };
      batch.push(entry);
      const image = document.createElement("div");
      image.innerHTML = svg;
      const p = document.createElement("p");
      p.textContent = entry.text;
      const save = document.createElement("button");
      save.textContent = "保存 SVG";
      save.onclick = safe(() => kit.saveText(`qrcode-${i + 1}.svg`, svg));
      card.append(image, p, save);
    } catch (e) {
      card.textContent = `第 ${i + 1} 项失败：${e.message}`;
    }
    $("batch-grid").append(card);
    $("batch-status").textContent = `已处理 ${i + 1}/${lines.length}`;
    await new Promise(requestAnimationFrame);
  }
  $("batch-save").disabled = !batch.length;
  $("batch-status").textContent = `${batch.length}/${lines.length} 项生成成功`;
});
$("batch-save").onclick = safe(() =>
  kit.saveText(
    "qrcode-gallery.html",
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>二维码图集</title><style>body{font:14px system-ui;display:flex;gap:24px;flex-wrap:wrap;padding:24px}figure{width:200px;margin:0;break-inside:avoid}svg{width:100%;height:auto}figcaption{overflow-wrap:anywhere;margin-top:12px}</style>' +
      batch
        .map(
          (item) =>
            "<figure>" +
            item.svg +
            "<figcaption>" +
            PluginKit.escape(item.text) +
            "</figcaption></figure>",
        )
        .join("") +
      "</html>",
  ),
);
kit.onMode((mode) => {
  $("options").open = mode !== "quick";
});
$("options").open = kit.mode !== "quick";
api?.onEnter?.(({ code, payload: incoming }) => {
  if (code === "decode") tab("decode");
  const text = typeof incoming === "string" ? incoming : incoming?.text;
  if (text) {
    tab("generate");
    $("template").value = "text";
    $("input").value = text;
    PluginKit.upgradeSelects(); // 同步自定义下拉选中标签
    template();
  }
  if (incoming?.dataUrl?.startsWith("data:image/")) {
    tab("decode");
    processImages([{ name: "传入图片", dataUrl: incoming.dataUrl }]);
  }
});
api?.onDestroy?.(() => {
  decodeToken++;
  batchToken++;
  clearTimeout(timer);
  decoded = [];
  history = [];
  batch = [];
});
await kit.ready;
function applySettings() {
  $("size").value = String(kit.settings.defaultSize);
  $("ecc").value = kit.settings.defaultEcc;
  $("fg").value = kit.settings.foreground;
  $("bg").value = kit.settings.background;
  PluginKit.upgradeSelects(); // 设置驱动的赋值后同步下拉标签
  generate();
}
// 点样式分段控件
for (const entry of DOT_STYLES) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.dot = entry.id;
  button.textContent = entry.label;
  $("dot-style-seg").append(button);
}
document.querySelectorAll("[data-dot]").forEach((button) => {
  button.onclick = () => {
    dotStyle = button.dataset.dot;
    syncStyleControls();
    generate();
    void saveStyle();
  };
});
await loadStyle();
await loadHistory();
applySettings();
kit.onSettings(applySettings);
