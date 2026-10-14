import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
import { md5, bytesToHex, bytesToBase64, base64ToBytes, HASH_ALGOS, subtle } from "./md5.mjs";
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

/* ── 初始化 ─────────────────────────── */
$("hash-list").innerHTML = HASH_ALGOS.map(
  (a) =>
    `<li class="hash-row" title="${a.js ? "纯 JS 实现（WebCrypto 不提供 MD5）" : a.id === "SHA-224" ? "部分平台 WebCrypto 不支持 SHA-224，缺失时显示 —" : ""}"><span class="algo">${esc(a.label)}</span><span class="value empty" data-algo="${a.id}">—</span><button data-copy="${a.id}" disabled>复制</button></li>`,
).join("");

(async () => {
  await kit.ready;
  encoding = kit.settings.encoding === "base64" ? "base64" : "hex";
  if (kit.settings.hmacAlg && ["SHA-1", "SHA-256", "SHA-384", "SHA-512"].includes(kit.settings.hmacAlg))
    $("hmac-alg").value = kit.settings.hmacAlg;
  syncEncoding();
  await restoreRsaKeys();
  renderHashes();
})();

function syncEncoding() {
  $("enc-hex").setAttribute("aria-pressed", String(encoding === "hex"));
  $("enc-base64").setAttribute("aria-pressed", String(encoding === "base64"));
}

/* ── 哈希 ─────────────────────────── */
async function computeHash(algo, text) {
  if (!text) return null;
  if (algo === "MD5") return md5(text);
  try {
    const buf = await subtle.digest(algo, new TextEncoder().encode(text));
    return encoding === "hex" ? bytesToHex(new Uint8Array(buf)) : bytesToBase64(new Uint8Array(buf));
  } catch {
    return null; // 平台不支持（如部分引擎无 SHA-224）
  }
}

async function renderHashes() {
  const text = $("hash-input").value;
  for (const algo of HASH_ALGOS) {
    const cell = document.querySelector(`[data-algo="${algo.id}"]`);
    const btn = document.querySelector(`[data-copy="${algo.id}"]`);
    const value = await computeHash(algo.id, text);
    cell.textContent = value || "—";
    cell.classList.toggle("empty", !value);
    btn.disabled = !value;
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

/* 文件哈希：分块 SHA-256（DOM File API + incremental 不可用 → 分块累计进 subtle 不支持，改为一次性 readAsArrayBuffer，>32MB 提示） */
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
  } catch (error) { kit.toast(error.message, 'error'); }
});
$("hash-file").addEventListener("change", () => {
  const file = $("hash-file").files?.[0];
  if (file) void hashFile(file);
});
async function hashFile(file) {
  const box = $("hash-file-result");
  if (file.size > 32 * 1024 * 1024) {
    box.hidden = false;
    box.textContent = `${file.name} 超过 32MB，请取内容片段计算`;
    kit.toast("文件超过 32MB", "error");
    return;
  }
  drop.querySelector("#hash-file-label").textContent = `正在计算 ${file.name} …`;
  try {
    const buf = await file.arrayBuffer();
    const digest = await subtle.digest("SHA-256", buf);
    box.hidden = false;
    box.innerHTML = `<strong>${esc(file.name)}</strong> · ${(file.size / 1024).toFixed(1)} KB<br>SHA-256 = <span class="mono">${bytesToHex(new Uint8Array(digest))}</span>`;
    kit.copy(bytesToHex(new Uint8Array(digest))).catch(() => {});
  } catch (e) {
    box.hidden = false;
    box.textContent = "读取失败：" + e.message;
  } finally {
    drop.querySelector("#hash-file-label").textContent = "拖入文件或点击选择 · 分块计算 SHA-256";
  }
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
  try {
    const buf = await subtle.encrypt({ name: "RSA-OAEP" }, rsaKeys.publicKey, new TextEncoder().encode($("rsa-text").value));
    lastOutput.rsa = bytesToBase64(new Uint8Array(buf));
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    kit.toast("加密失败：" + e.message, "error");
  }
};
$("rsa-decrypt").onclick = async () => {
  try {
    const buf = await subtle.decrypt({ name: "RSA-OAEP" }, rsaKeys.privateKey, base64ToBytes($("rsa-text").value));
    lastOutput.rsa = new TextDecoder().decode(buf);
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    kit.toast("解密失败：" + e.message, "error");
  }
};
$("rsa-sign").onclick = async () => {
  try {
    const buf = await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsaKeys.signKey, new TextEncoder().encode($("rsa-text").value));
    lastOutput.rsa = bytesToBase64(new Uint8Array(buf));
    $("rsa-out").textContent = lastOutput.rsa;
    $("rsa-copy").disabled = false;
  } catch (e) {
    kit.toast("签名失败：" + e.message, "error");
  }
};
$("rsa-verify").onclick = async () => {
  try {
    const ok = await subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      rsaKeys.verifyKey,
      base64ToBytes($("rsa-text").value),
      new TextEncoder().encode($("rsa-text").value),
    );
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
