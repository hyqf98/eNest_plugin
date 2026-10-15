import {
  CHARACTER_SETS,
  generatePassword,
  generatePassphrase,
  generatePin,
  uuidV4,
  entropyEstimate,
  passphraseEntropy,
  pinEntropy,
  guessEntropy,
  crackTimeEstimate,
  strengthIssues,
} from "./core.mjs";

const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);

let kind = "password";
let values = [];
let history = [];
let masked = true;
let historyEnabled = true;
const REVEAL_MS = 1500;
const HISTORY_KEY = "password_kit.history.v1";
const HISTORY_SETTING_KEY = "keepHistory";

const kit = PluginKit.create({
  title: "密码工具箱",
  quickPlaceholder: "输入长度、uuid 或 strength",
  height: 540,
  defaults: {
    defaultLength: 16,
    avoidAmbiguous: false,
    maskResults: true,
    uuidUppercase: false,
    uuidHyphens: true,
    keepHistory: true,
  },
  onQuery(text) {
    if (/strength|强度/i.test(text)) changeKind("inspect");
    else if (/uuid/i.test(text)) changeKind("uuid");
    else if (/pin|密码/i.test(text) === false && /^\d{1,3}$/.test(text.trim())) {
      changeKind("password");
      setLength(Number(text));
    }
  },
  onAction(action) {
    if (action === "submit") generate(true);
    else if (action === "clear") {
      values = [];
      render();
    }
  },
});

// —— 模式描述（footer 隐私提示随模式切换，传达「责任」）——
const KIND_META = {
  password: { title: "生成结果", privacy: "密码仅在当前会话保留，关闭插件后清除" },
  passphrase: { title: "生成结果", privacy: "密码短语在本地生成，会话结束即清除" },
  pin: { title: "生成结果", privacy: "PIN 在本地生成，会话结束即清除" },
  uuid: { title: "生成结果", privacy: "随机 UUID v4 · 本地生成" },
  inspect: { title: "强度报告", privacy: "分析完全本地进行：不上传、不存储输入的密码" },
};

function panelName() {
  return kind === "inspect" ? "inspect" : kind;
}

// —— 参数面板 —— //
function passwordOptions() {
  return {
    length: Number($("length").value),
    sets: Object.keys(CHARACTER_SETS).filter((key) => $(key).checked),
    avoidAmbiguous: $("ambiguous").checked,
    exclude: $("exclude").value,
  };
}

function passphraseOptions() {
  return {
    words: Number($("words").value),
    separator: $("phrase-separator").value,
    capitalize: $("phrase-capitalize").checked,
    appendNumber: $("phrase-number").checked,
  };
}

function bitsForCurrent() {
  if (kind === "password") return entropyEstimate(passwordOptions());
  if (kind === "passphrase") return passphraseEntropy(passphraseOptions());
  if (kind === "pin") return pinEntropy(Number($("pin-length").value));
  return null;
}

function updateEntropyLine() {
  const el = $("entropy-line");
  if (!el) return;
  const bits = bitsForCurrent();
  el.textContent = bits == null ? "" : `约 ${bits} bits 随机熵（字符池上限估计）`;
}

function strength() {
  try {
    entropyEstimate(passwordOptions());
    $("error").textContent = "";
    setGenerateDisabled(false);
  } catch (e) {
    if (kind === "password") {
      $("error").textContent = e.message;
      setGenerateDisabled(true);
    }
  }
  updateEntropyLine();
}

function setGenerateDisabled(disabled) {
  if (kind === "inspect") return;
  $("generate").disabled = disabled;
  $("generate-copy").disabled = disabled;
}

function setLength(value) {
  const n = Math.max(6, Math.min(128, Math.round(Number(value) || 16)));
  $("length").value = n;
  $("length-number").value = n;
  $("length-value").textContent = n;
  strength();
}

function setWords(value) {
  const n = Math.max(2, Math.min(12, Math.round(Number(value) || 4)));
  $("words").value = n;
  $("words-value").textContent = n;
  updateEntropyLine();
}

function setPinLength(value) {
  const n = Math.max(4, Math.min(16, Math.round(Number(value) || 6)));
  $("pin-length").value = n;
  $("pin-length-value").textContent = n;
  updateEntropyLine();
}

// —— 模式切换 —— //
function changeKind(next) {
  kind = next;
  document.querySelectorAll("[data-kind]").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.kind === kind)),
  );
  document.querySelectorAll(".params .panel").forEach((p) => {
    p.hidden = p.dataset.panel !== panelName();
  });
  const genOnly = kind !== "inspect";
  document.querySelectorAll("[data-gen-only]").forEach((el) => (el.hidden = !genOnly));
  $("mask").hidden = kind === "inspect";
  $("history-details").hidden = kind === "inspect" || !historyEnabled;
  $("inspect-report").hidden = kind !== "inspect";
  $("board-title").textContent = KIND_META[kind].title;
  $("privacy").textContent = KIND_META[kind].privacy;
  $("error").textContent = "";
  if (kind !== "inspect") {
    setGenerateDisabled(false);
    if (kind === "password") strength();
    else updateEntropyLine();
  } else {
    renderInspect();
  }
  render();
}

// —— 结果行 —— //
function formatted() {
  if (kind !== "uuid" || $("separator").value === "newline") return values.join("\n");
  if ($("separator").value === "json") return JSON.stringify(values, null, 2);
  return values.join(",");
}

function row(value, i, isHistory = false) {
  const b = document.createElement("button");
  b.className = "secret-row";
  const num = document.createElement("span");
  num.className = "number";
  num.textContent = String(i + 1).padStart(2, "0");
  const text = document.createElement("span");
  text.className = "secret";
  text.textContent =
    masked && (kind === "password" || kind === "passphrase" || kind === "pin" || isHistory)
      ? "•".repeat(Math.min(24, value.length))
      : value;
  const hint = document.createElement("span");
  hint.className = "action";
  hint.textContent = "复制";
  b.setAttribute("aria-label", "复制第 " + (i + 1) + " 条");
  b.append(num, text, hint);
  b.onclick = () => copy(value);
  // 敏感值默认掩码：悬停 / 长按短时揭示，离开即恢复
  b.addEventListener("pointerenter", () => {
    if (!masked) return;
    text.textContent = value;
  });
  b.addEventListener("pointerleave", () => {
    if (!masked) return;
    text.textContent = "•".repeat(Math.min(24, value.length));
  });
  return b;
}

function render() {
  $("results").replaceChildren();
  if (!values.length)
    $("results").innerHTML =
      '<p class="empty">设置参数后点击生成。<br>每条结果都可以单独复制。</p>';
  values.forEach((v, i) => $("results").append(row(v, i)));
  $("result-count").textContent = values.length ? values.length + " 条" : "";
  $("copy-all").disabled = !values.length;
  $("history").replaceChildren();
  history.forEach((v, i) => $("history").append(row(v, i, true)));
  $("history-count").textContent = history.length ? history.length + " 条" : "";
  $("mask").textContent = masked ? "显示内容" : "隐藏内容";
  $("mask").setAttribute("aria-pressed", String(masked));
}

// —— 强度检查 —— //
const LEVEL_WORDS = { weak: "弱", fair: "一般", strong: "强" };
function levelOf(bits) {
  return bits < 45 ? "weak" : bits < 70 ? "fair" : "strong";
}

function renderInspect() {
  const report = $("inspect-report");
  const text = $("inspect-input").value;
  report.replaceChildren();
  if (!text) {
    report.hidden = true;
    return;
  }
  report.hidden = false;
  const bits = guessEntropy(text);
  const level = levelOf(bits);
  const crack = crackTimeEstimate(bits);
  const issues = strengthIssues(text);

  const verdict = document.createElement("div");
  verdict.className = "verdict";
  const word = document.createElement("span");
  word.className = "score-word";
  word.dataset.level = level;
  word.textContent = LEVEL_WORDS[level];
  const bitsEl = document.createElement("span");
  bitsEl.className = "score-bits";
  bitsEl.textContent = `≈ ${bits} bits`;
  verdict.append(word, bitsEl);

  const meter = document.createElement("div");
  meter.className = "meter";
  const fill = document.createElement("i");
  fill.dataset.level = level;
  fill.style.width = Math.min(100, (bits / 100) * 100) + "%";
  meter.append(fill);

  const crackLine = document.createElement("p");
  crackLine.className = "crack-line";
  crackLine.innerHTML = "离线慢哈希场景下，估算破解时间 <b></b>";
  crackLine.querySelector("b").textContent = crack.value;

  report.append(verdict, meter, crackLine);
  if (issues.length) {
    const list = document.createElement("ul");
    list.className = "issues";
    for (const issue of issues) {
      const li = document.createElement("li");
      li.textContent = issue;
      list.append(li);
    }
    report.append(list);
  }
}

// —— 生成 —— //
function makeOne() {
  if (kind === "password") return generatePassword(passwordOptions());
  if (kind === "passphrase") return generatePassphrase(passphraseOptions());
  if (kind === "pin") return generatePin(Number($("pin-length").value));
  return uuidV4({
    uppercase: $("uppercase").checked,
    hyphens: $("hyphens").checked,
  });
}

function generate(copyAfter = false) {
  try {
    const count = Number($("count").value);
    if (!Number.isInteger(count) || count < 1 || count > 100)
      throw new Error("数量应为 1–100 的整数");
    values = Array.from({ length: count }, makeOne);
    if (kind !== "uuid" && historyEnabled) {
      history = [...values, ...history].slice(0, 12);
      void kit.save(HISTORY_KEY, history).catch(() => {});
    }
    $("error").textContent = "";
    render();
    if (copyAfter) copy(formatted());
  } catch (e) {
    values = [];
    render();
    $("error").textContent = e.message;
  }
}

async function copy(text) {
  try {
    // 生成结果写剪贴板时避免进入剪贴板历史明文：优先带排除标记
    await api.clipboard.writeText(String(text), { excludeFromHistory: true });
    kit.toast("已复制", "success");
    return true;
  } catch (error) {
    return kit.copy(text).catch((err) => {
      kit.toast(err.message, "error");
      return false;
    });
  }
}

function clearHistory() {
  history = [];
  void kit.save(HISTORY_KEY, history).catch(() => {});
  render();
}

// —— 事件绑定 —— //
document.querySelectorAll("[data-kind]").forEach((b) => {
  b.onclick = () => changeKind(b.dataset.kind);
});
document.querySelectorAll("[data-length]").forEach((b) => {
  b.onclick = () => setLength(b.dataset.length);
});
document.querySelectorAll("[data-words]").forEach((b) => {
  b.onclick = () => setWords(b.dataset.words);
});
document.querySelectorAll("[data-pin]").forEach((b) => {
  b.onclick = () => setPinLength(b.dataset.pin);
});
$("length").oninput = () => setLength($("length").value);
$("length-number").onchange = () => setLength($("length-number").value);
$("words").oninput = () => setWords($("words").value);
$("pin-length").oninput = () => setPinLength($("pin-length").value);
for (const key of [...Object.keys(CHARACTER_SETS), "ambiguous", "exclude"])
  $(key).addEventListener("input", strength);
$("phrase-separator").onchange = updateEntropyLine;
$("phrase-number").onchange = updateEntropyLine;
$("mask").onclick = () => {
  masked = !masked;
  render();
};
$("generate").onclick = () => generate();
$("generate-copy").onclick = () => generate(true);
$("copy-all").onclick = () => values.length && copy(formatted());
$("clear-results").onclick = () => {
  values = [];
  render();
};
$("inspect-input").addEventListener("input", renderInspect);
$("clear-history").onclick = (e) => {
  e.preventDefault();
  clearHistory();
};
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.isComposing &&
    e.target.tagName !== "BUTTON" &&
    e.target.id !== "inspect-input"
  ) {
    e.preventDefault();
    generate(e.shiftKey);
  }
});

// —— 生命周期 —— //
api?.onEnter?.(({ code, payload }) => {
  const text = typeof payload === "string" ? payload : payload?.text;
  if (code === "uuid" || text === "uuid") changeKind("uuid");
  else if (code === "password") changeKind("password");
  else if (code === "inspect") changeKind("inspect");
  if (/^\d{1,3}$/.test(text || "")) setLength(Number(text));
});
api?.onDestroy?.(() => {
  values = [];
  history = [];
  $("results").replaceChildren();
  $("history").replaceChildren();
  $("inspect-input").value = "";
});
await kit.ready;
historyEnabled = kit.settings.keepHistory !== false;
setLength(kit.settings.defaultLength);
$("ambiguous").checked = Boolean(kit.settings.avoidAmbiguous);
masked = kit.settings.maskResults !== false;
$("uppercase").checked = Boolean(kit.settings.uuidUppercase);
$("hyphens").checked = kit.settings.uuidHyphens !== false;
try {
  const saved = await kit.load(HISTORY_KEY, []);
  if (historyEnabled && Array.isArray(saved)) history = saved.map(String).slice(0, 12);
} catch {}
strength();
changeKind("password");
render();
kit.onSettings((settings) => {
  historyEnabled = settings.keepHistory !== false;
  if (!historyEnabled) clearHistory();
  $("history-details").hidden = kind === "inspect" || !historyEnabled;
  setLength(settings.defaultLength);
  $("ambiguous").checked = Boolean(settings.avoidAmbiguous);
  masked = settings.maskResults !== false;
  $("uppercase").checked = Boolean(settings.uuidUppercase);
  $("hyphens").checked = settings.uuidHyphens !== false;
  strength();
  render();
});
