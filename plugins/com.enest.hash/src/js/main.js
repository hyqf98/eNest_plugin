import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
import {
  md5, bytesToHex, bytesToBase64, base64ToBytes,
  HASH_ALGOS, subtle,
  compareDigest, normalizeDigest,
} from "./md5.mjs";
import { decodeJwt, annotateTimes } from "./jwt.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const esc = PluginKit.escape;

const kit = PluginKit.create({
  title: "哈希与加密",
  quickPlaceholder: "输入即算：SHA-1/224/256/384/512 · MD5",
  height: 460,
  defaults: { encoding: "hex", hmacAlg: "SHA-256" },
  onQuery: (value) => {
    $("hash-input").value = String(value);
    void renderHashes();
  },
  onAction: (action) => {
    if (action === "clear") {
      $("hash-input").value = "";
      renderHashes();
    }
  },
});

bindFileInput(document.getElementById('hash-file'), { api, onError: error => kit.toast(error.message, 'error') })
const ENC_KEY = "hash_encoding_v1";
const RSA_KEY_REF = "rsa_keypair_b64_v1";
let encoding = "hex";
let currentTab = "hash";
let lastOutput = { hmac: "", aes: "", rsa: "", random: "" };
let rsaKeys = null;
let fileDigestHex = ""; // 最近一次文件 SHA-256，供「校验对比」直连
let lastPrimaryHex = ""; // 文本输入的 SHA-256（hex 基准，供对比）

/* ── 初始化 ─────────────────────────── */
$("hash-list").innerHTML = HASH_ALGOS.map(
  (a) =>
    `<li class="hash-card" title="${a.js ? "纯 JS 实现（WebCrypto 不提供 MD5）" : a.id === "SHA-224" ? "部分平台 WebCrypto 不支持 SHA-224，缺失时显示 —" : ""}"><div class="card-head"><span class="algo">${esc(a.label)}</span><button data-copy="${a.id}" class="card-copy" disabled>复制</button></div><span class="value empty" data-algo="${a.id}">—</span></li>`,
).join("");

(async () => {
  await kit.ready;
  encoding = kit.settings.encoding === "base64" ? "base64" : "hex";
  if (kit.settings.hmacAlg && ["SHA-1", "SHA-256", "SHA-384", "SHA-512"].includes(kit.settings.hmacAlg))
    $("hmac-alg").value = kit.settings.hmacAlg;
  PluginKit.upgradeSelects(); // 纯 .value 赋值不触发 change，同步自定义下拉标签
  syncEncoding();
  await restoreRsaKeys();
  renderHashes();
})();

function syncEncoding() {
  $("enc-hex").setAttribute("aria-pressed", String(encoding === "hex"));
  $("enc-hex").classList.toggle("active", encoding === "hex");
  $("enc-base64").setAttribute("aria-pressed", String(encoding === "base64"));
  $("enc-base64").classList.toggle("active", encoding === "base64");
}

/* ── 哈希 ─────────────────────────── */
async function computeHash(algo, text) {
  if (!text) return null;
  if (algo === "MD5") return encoding === "hex" ? md5(text) : bytesToBase64(hexToBytes(md5(text)));
  try {
    const buf = await subtle.digest(algo, new TextEncoder().encode(text));
    return encoding === "hex" ? bytesToHex(new Uint8Array(buf)) : bytesToBase64(new Uint8Array(buf));
  } catch {
    return null; // 平台不支持（如部分引擎无 SHA-224）
  }
}

function hexToBytes(hex) {
  return Uint8Array.from(String(hex).match(/.{2}/g) || [], (v) => parseInt(v, 16));
}

async function renderHashes() {
  const text = $("hash-input").value;
  $("hash-empty").hidden = !!text;
  for (const algo of HASH_ALGOS) {
    const cell = document.querySelector(`[data-algo="${algo.id}"]`);
    const btn = document.querySelector(`[data-copy="${algo.id}"]`);
    const value = await computeHash(algo.id, text);
    cell.textContent = value || "—";
    cell.classList.toggle("empty", !value);
    btn.disabled = !value;
  }
  // 校验对比基准：文本输入时取 SHA-256 hex；文件哈希刚算完时保持 fileDigestHex
  if (text) lastPrimaryHex = await hexOf("SHA-256", text);
  else if (!fileDigestHex) lastPrimaryHex = "";
  runVerify();
}

async function hexOf(algo, text) {
  if (algo === "MD5") return md5(text);
  try {
    const buf = await subtle.digest(algo, new TextEncoder().encode(text));
    return bytesToHex(new Uint8Array(buf));
  } catch {
    return "";
  }
}

let hashDebounce;
$("hash-input").addEventListener("input", () => {
  clearTimeout(hashDebounce);
  hashDebounce = setTimeout(renderHashes, 150);
});
$("hash-paste").onclick = async () => {
  try {
    $("hash-input").value = String((await api.clipboard.readText()) ?? "");
    renderHashes();
  } catch (e) {
    kit.toast(e.message, "error");
  }
};
$("hash-clear").onclick = () => {
  $("hash-input").value = "";
  renderHashes();
  $("hash-input").focus();
};
$("hash-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn || btn.disabled) return;
  const value = document.querySelector(`[data-algo="${btn.dataset.copy}"]`)?.textContent;
  if (value) kit.copy(value).catch((err) => kit.toast(err.message, "error"));
});

/* ── 文件哈希：SHA-256 + SHA-1 + MD5 并行，进度反馈 ── */
const drop = $("hash-drop");
drop.addEventListener("click", () => $("hash-file").click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("hash-file").click();
  }
});
drop.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) {
    e.preventDefault();
    drop.classList.add("dragover");
  }
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", async (e) => {
  drop.classList.remove("dragover");
  e.preventDefault();
  try {
    const [file] = await readDroppedFiles(e.dataTransfer?.files, { api });
    if (file) await hashFile(file);
  } catch (error) {
    kit.toast(error.message, 'error');
  }
});
$("hash-file").addEventListener("change", () => {
  const file = $("hash-file").files?.[0];
  if (file) void hashFile(file);
});

function setProgress(ratio) {
  const box = $("hash-progress");
  if (ratio == null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("hash-progress-bar").style.width = Math.round(ratio * 100) + "%";
}

async function hashFile(file) {
  const box = $("hash-file-result");
  if (file.size > 32 * 1024 * 1024) {
    box.hidden = false;
    box.textContent = `${file.name} 超过 32MB，请取内容片段计算`;
    kit.toast("文件超过 32MB", "error");
    return;
  }
  drop.classList.add("busy");
  $("hash-file-label").textContent = `正在读取 ${file.name}（${sizeLabel(file.size)}）…`;
  box.hidden = true;
  setProgress(0.15);
  try {
    // 读取分两段，给大文件一个可见的进行中状态，避免长任务无反馈
    await frame();
    const buf = file.arrayBuffer ? await file.arrayBuffer() : (await readAuthorizedBuffer(file));
    setProgress(0.6);
    await frame();
    const bytes = new Uint8Array(buf);
    const [sha256, sha1, digest5] = await Promise.all([
      subtle.digest("SHA-256", bytes).catch(() => null),
      subtle.digest("SHA-1", bytes).catch(() => null),
      Promise.resolve(md5(bytes)),
    ]);
    setProgress(1);
    fileDigestHex = sha256 ? bytesToHex(new Uint8Array(sha256)) : "";
    const lines = [`<strong>${esc(file.name)}</strong> · ${sizeLabel(file.size)}`];
    if (sha256) lines.push(`SHA-256 <span class="mono">${bytesToHex(new Uint8Array(sha256))}</span>`);
    if (sha1) lines.push(`SHA-1 <span class="mono dim">${bytesToHex(new Uint8Array(sha1))}</span>`);
    lines.push(`MD5 <span class="mono dim">${digest5}</span>`);
    box.innerHTML = lines.join("<br>");
    box.hidden = false;
    lastPrimaryHex = fileDigestHex || lastPrimaryHex;
    runVerify();
    if (fileDigestHex) {
      kit.copy(fileDigestHex).catch(() => {});
      kit.toast("SHA-256 已算出并复制", "success");
    }
  } catch (e) {
    box.hidden = false;
    box.textContent = "读取失败：" + e.message;
  } finally {
    drop.classList.remove("busy");
    setProgress(null);
    $("hash-file-label").textContent = "拖入文件或点击选择 · 计算 SHA-256 / SHA-1 / MD5";
  }
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function readAuthorizedBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取文件内容"));
    reader.readAsArrayBuffer(file);
  });
}

function sizeLabel(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";
}

/* ── 校验对比：逐字符 diff + 结论 ── */
$("verify-input").addEventListener("input", runVerify);
$("verify-copy").onclick = () => {
  const value = document.querySelector('[data-algo="SHA-256"]')?.textContent;
  if (value && value !== "—") kit.copy(value).catch((e) => kit.toast(e.message, "error"));
};
function runVerify() {
  const out = $("verify-out");
  const expected = $("verify-input").value.trim();
  $("verify-copy").disabled = !lastPrimaryHex;
  if (!expected || !lastPrimaryHex) {
    out.hidden = true;
    out.replaceChildren();
    return;
  }
  const verdict = compareDigest(lastPrimaryHex, expected);
  out.hidden = false;
  out.replaceChildren();
  const badge = document.createElement("span");
  if (verdict.invalid) {
    badge.className = "pk-badge pk-badge-warn";
    badge.textContent = "期望值不是十六进制";
    out.append(badge);
    return;
  }
  badge.className = "pk-badge " + (verdict.equal ? "pk-badge-ok" : "pk-badge-danger");
  badge.textContent = verdict.equal ? "校验一致" : "校验不一致";
  out.append(badge);
  if (!verdict.equal) {
    out.append(document.createTextNode(" 首个差异在第 " + (verdict.mismatch + 1) + " 位："));
    const code = document.createElement("code");
    code.className = "mono diff";
    for (const seg of segmentsOf(lastPrimaryHex, expected)) {
      const part = document.createElement("span");
      part.textContent = seg.text;
      part.className = seg.same ? "same" : "diff-bad";
      code.append(part);
    }
    out.append(code);
  }
}
function segmentsOf(actualHex, expectedText) {
  const actual = String(actualHex ?? "").toLowerCase();
  const { value: expected } = normalizeDigest(expectedText);
  const verdict = compareDigest(actual, expected);
  if (verdict.equal) return [{ text: expected, same: true }];
  const at = Math.max(0, verdict.mismatch);
  const segs = [];
  if (at > 0) segs.push({ text: expected.slice(0, at), same: true });
  segs.push({ text: expected.slice(at), same: false });
  return segs;
}

/* ── Tab 与输出编码 ─────────────────────────── */
$("tab-hash").onclick = () => switchTab("hash");
$("tab-crypto").onclick = () => switchTab("crypto");
$("tab-jwt").onclick = () => switchTab("jwt");
function switchTab(tab) {
  currentTab = tab;
  for (const [id, name] of [
    ["tab-hash", "hash"],
    ["tab-crypto", "crypto"],
    ["tab-jwt", "jwt"],
  ]) {
    $(id).setAttribute("aria-selected", String(name === tab));
    $(`page-${name}`).hidden = name !== tab;
  }
  reportHeight();
}
$("enc-hex").onclick = async () => {
  encoding = "hex";
  syncEncoding();
  await persist();
  renderHashes();
};
$("enc-base64").onclick = async () => {
  encoding = "base64";
  syncEncoding();
  await persist();
  renderHashes();
};
async function persist() {
  try {
    await kit.save(ENC_KEY, encoding);
  } catch {
    /* 忽略 */
  }
}

/* ── HMAC ─────────────────────────── */
$("hmac-key").addEventListener("input", scheduleHmac);
$("hmac-alg").addEventListener("change", () => {
  void api.settings.set("hmacAlg", $("hmac-alg").value).catch?.(() => {});
  scheduleHmac();
});
$("hmac-gen-key").onclick = () => {
  $("hmac-key").value = randomB64(32);
  scheduleHmac();
};
let hmacTimer;
function scheduleHmac() {
  clearTimeout(hmacTimer);
  hmacTimer = setTimeout(runHmac, 150);
}
async function runHmac() {
  const text = $("hash-input").value;
  const key = $("hmac-key").value;
  const out = $("hmac-out");
  $("hmac-copy").disabled = true;
  if (!text || !key || !subtle) {
    out.textContent = text ? "需要密钥" : "";
    return;
  }
  try {
    const cryptoKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: $("hmac-alg").value },
      false,
      ["sign"],
    );
    const sig = await subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(text));
    const bytes = new Uint8Array(sig);
    lastOutput.hmac = encoding === "hex" ? bytesToHex(bytes) : bytesToBase64(bytes);
    out.textContent = lastOutput.hmac;
    $("hmac-copy").disabled = false;
  } catch (e) {
    out.textContent = "HMAC 失败：" + e.message;
  }
}

/* ── AES-GCM ─────────────────────────── */
function showAesError(message) {
  $("aes-error").textContent = message;
  $("aes-error").hidden = !message;
}
async function getAesKey() {
  const b64 = $("aes-key").value.trim();
  if (!b64) throw new Error("请先生成或粘贴 AES 密钥");
  const raw = base64ToBytes(b64);
  if (![16, 24, 32].includes(raw.length)) throw new Error(`AES 密钥须为 16/24/32 字节，当前 ${raw.length} 字节`);
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function getAesIv() {
  const b64 = $("aes-iv").value.trim();
  if (!b64) throw new Error("请先生成或粘贴 IV");
  const iv = base64ToBytes(b64);
  if (iv.length !== 12) throw new Error(`GCM IV 须为 12 字节，当前 ${iv.length} 字节`);
  return iv;
}
function randomB64(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64(bytes);
}
$("aes-gen-key").onclick = () => {
  $("aes-key").value = randomB64(32);
  showAesError("");
};
$("aes-gen-iv").onclick = () => ($("aes-iv").value = randomB64(12));
$("aes-encrypt").onclick = async () => {
  showAesError("");
  try {
    const key = await getAesKey();
    const iv = await getAesIv();
    const plain = $("aes-text").value;
    if (!plain) throw new Error("明文为空");
    const buf = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
    lastOutput.aes = bytesToBase64(new Uint8Array(buf));
    $("aes-out").textContent = lastOutput.aes;
    $("aes-copy").disabled = false;
  } catch (e) {
    showAesError(e.message);
  }
};
$("aes-decrypt").onclick = async () => {
  showAesError("");
  try {
    const key = await getAesKey();
    const iv = await getAesIv();
    const cipher = base64ToBytes($("aes-text").value);
    const buf = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    lastOutput.aes = new TextDecoder().decode(buf);
    $("aes-out").textContent = lastOutput.aes;
    $("aes-copy").disabled = false;
  } catch (e) {
    showAesError("解密失败：" + e.message);
  }
};
$("aes-copy").onclick = () => kit.copy(lastOutput.aes).catch((e) => kit.toast(e.message, "error"));

/* ── RSA ─────────────────────────── */
function showRsaError(message) {
  $("rsa-error").textContent = message;
  $("rsa-error").hidden = !message;
}
async function exportB64(key, type) {
  const data = type === "pkcs8" ? await subtle.exportKey("pkcs8", key) : await subtle.exportKey("spki", key);
  return bytesToBase64(new Uint8Array(data));
}
async function restoreRsaKeys() {
  try {
    const saved = await kit.load(RSA_KEY_REF, null);
    if (!saved?.private || !saved?.public || !subtle) return;
    const priv = await subtle.importKey(
      "pkcs8",
      base64ToBytes(saved.private),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"],
    );
    const pub = await subtle.importKey(
      "spki",
      base64ToBytes(saved.public),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"],
    );
    rsaKeys = { privateKey: priv, publicKey: pub };
    $("rsa-status").textContent = "已恢复上次密钥对";
    enableRsa(true);
  } catch {
    /* 忽略损坏的密钥 */
  }
}
function enableRsa(on) {
  for (const id of ["rsa-encrypt", "rsa-decrypt", "rsa-sign", "rsa-verify"]) $(id).disabled = !on;
  $("rsa-copy").disabled = !on || !lastOutput.rsa;
}
$("rsa-gen").onclick = async () => {
  $("rsa-status").textContent = "生成中…";
  try {
    const pair = await subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const sigPair = await subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    rsaKeys = { privateKey: pair.privateKey, publicKey: pair.publicKey, signKey: sigPair.privateKey, verifyKey: sigPair.publicKey };
    const dump = {
      private: await exportB64(pair.privateKey, "pkcs8"),
      public: await exportB64(pair.publicKey, "spki"),
    };
    await kit.save(RSA_KEY_REF, dump);
    $("rsa-status").textContent = `密钥对已生成并持久化 · 公钥 ${dump.public.length} 字符`;
    enableRsa(true);
  } catch (e) {
    $("rsa-status").textContent = "";
    kit.toast("RSA 生成失败：" + e.message, "error");
  }
};
$("rsa-encrypt").onclick = async () => {
  showRsaError("");
  try {
    const buf = await subtle.encrypt({ name: "RSA-OAEP" }, rsaKeys.publicKey, new TextEncoder().encode($("rsa-text").value));
    lastOutput.rsa = bytesToBase64(new Uint8Array(buf));
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    showRsaError("加密失败：" + e.message);
  }
};
$("rsa-decrypt").onclick = async () => {
  showRsaError("");
  try {
    const buf = await subtle.decrypt({ name: "RSA-OAEP" }, rsaKeys.privateKey, base64ToBytes($("rsa-text").value));
    lastOutput.rsa = new TextDecoder().decode(buf);
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    showRsaError("解密失败：" + e.message);
  }
};
// PSS 签名输入为明文，签名为 base64；验签时把明文与 base64 签名分别传入
let lastSignatureB64 = "";
$("rsa-sign").onclick = async () => {
  showRsaError("");
  try {
    const buf = await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsaKeys.signKey, new TextEncoder().encode($("rsa-text").value));
    lastSignatureB64 = bytesToBase64(new Uint8Array(buf));
    lastOutput.rsa = lastSignatureB64;
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    showRsaError("签名失败：" + e.message);
  }
};
$("rsa-verify").onclick = async () => {
  showRsaError("");
  try {
    const input = $("rsa-text").value.trim();
    const signature = base64ToBytes(lastSignatureB64 || input);
    const data = new TextEncoder().encode(lastSignatureB64 ? $("rsa-text").value : "");
    if (!lastSignatureB64 && !input) throw new Error("没有可验证的签名");
    const ok = await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsaKeys.verifyKey, signature, data);
    kit.toast(ok ? "验签通过" : "验签失败：签名不匹配", ok ? "success" : "error");
  } catch (e) {
    kit.toast("验签失败：" + e.message, "error");
  }
};
$("rsa-copy").onclick = () => kit.copy(lastOutput.rsa).catch((e) => kit.toast(e.message, "error"));

/* ── 随机盐 / IV 生成器 ─────────────────────────── */
$("gen-random").onclick = () => {
  lastOutput.random = randomB64(16);
  $("random-out").textContent = lastOutput.random;
  $("random-copy").disabled = false;
};
$("random-copy").onclick = () => kit.copy(lastOutput.random).catch((e) => kit.toast(e.message, "error"));

/* ── JWT ─────────────────────────── */
$("jwt-input").addEventListener("input", () => {
  clearTimeout(jwtTimer);
  jwtTimer = setTimeout(renderJwt, 200);
});
let jwtTimer;
function renderJwt() {
  const box = $("jwt-error");
  box.hidden = true;
  const token = $("jwt-input").value.trim();
  if (!token) {
    $("jwt-header").textContent = "";
    $("jwt-payload").textContent = "";
    $("jwt-signature").textContent = "";
    reportHeight();
    return;
  }
  try {
    const { header, payload, signature } = decodeJwt(token);
    const times = annotateTimes(payload);
    $("jwt-header").textContent = JSON.stringify(header, null, 2);
    $("jwt-payload").textContent = JSON.stringify({ ...payload, ...times }, null, 2);
    $("jwt-signature").textContent = signature || "（空）";
  } catch (e) {
    box.textContent = e.message;
    box.hidden = false;
  }
  reportHeight();
}

/* Quick 高度自适应 */
let lastHeight = 0;
function reportHeight() {
  if (kit.mode !== "quick") return;
  const height = Math.min(640, Math.max(320, document.body.scrollHeight));
  if (Math.abs(height - lastHeight) < 24) return;
  lastHeight = height;
  void api?.ui?.setHeight?.(height);
}
new ResizeObserver(reportHeight).observe(document.body);

runHmac();
