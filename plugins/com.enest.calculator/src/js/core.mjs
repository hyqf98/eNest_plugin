const FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
};
/** 命名常量（单字母，可被用户变量覆盖；e 保留为欧拉数，m 保留为内存） */
export const CONSTANTS = { g: 9.80665 };
/** 变量名合法性：单字母、非 e（欧拉数）非 m（内存） */
export function isVariableName(name) {
  return /^[a-z]$/i.test(name) && !"em".includes(name.toLowerCase());
}
/** 识别赋值语句：x = 2^10 → { name, expr }；非赋值返回 null */
export function parseAssignment(source) {
  const m = /^\s*([a-z])\s*=(?!=)\s*(.+)$/i.exec(source);
  if (!m || !isVariableName(m[1])) return null;
  return { name: m[1].toLowerCase(), expr: m[2] };
}
export function calculate(
  source,
  { ans = 0, memory = 0, degrees = false, vars = {} } = {},
) {
  if (!source.trim()) return null;
  if (source.length > 4096) throw new Error("表达式过长（最多 4096 字符）");
  const tokens = [];
  const re =
    /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?|([a-zA-Zπ]+)|([+\-*/%^(),]))/gy;
  let at = 0;
  while (at < source.length) {
    if (!source.slice(at).trim()) break;
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) throw new Error("第 " + (at + 1) + " 位无法识别");
    tokens.push(
      m[1] ? Number(m[1] + (m[2] == null ? "" : "e" + m[2])) : m[3] || m[4],
    );
    at = re.lastIndex;
  }
  let i = 0;
  let depth = 0;
  const take = () => tokens[i++];
  function atom() {
    if (++depth > 100) throw new Error("括号嵌套过深");
    let v;
    const t = take();
    if (typeof t === "number") v = t;
    else if (t === "(") {
      v = sum();
      if (take() !== ")") throw new Error("括号不匹配");
    } else if (typeof t === "string" && /^[a-zπ]+$/i.test(t)) {
      const name = t.toLowerCase();
      if (name in FUNCTIONS) {
        if (take() !== "(") throw new Error(name + " 需要括号");
        const args = [sum()];
        while (tokens[i] === ",") {
          take();
          args.push(sum());
        }
        if (take() !== ")") throw new Error("函数括号不匹配");
        const variadic = name === "min" || name === "max";
        if (!variadic && args.length !== (name === "pow" ? 2 : 1))
          throw new Error("函数参数数量不正确");
        if (degrees && ["sin", "cos", "tan"].includes(name))
          args[0] *= Math.PI / 180;
        v = FUNCTIONS[name](...args);
        if (degrees && ["asin", "acos", "atan"].includes(name))
          v *= 180 / Math.PI;
      } else if (name === "pi" || name === "π") v = Math.PI;
      else if (name === "e") v = Math.E;
      else if (name === "ans") v = ans;
      else if (name === "m") v = memory;
      else if (isVariableName(name) && name in vars) v = Number(vars[name]);
      else if (name in CONSTANTS) v = CONSTANTS[name];
      else if (isVariableName(name))
        throw new Error("未知变量 " + name + "，先用 " + name + " = 5 赋值");
      else throw new Error("未知名称：" + t);
    } else throw new Error("表达式不完整");
    depth--;
    return v;
  }
  function unary() {
    if (tokens[i] === "-") {
      take();
      return -unary();
    }
    if (tokens[i] === "+") {
      take();
      return unary();
    }
    return power();
  }
  function power() {
    const v = atom();
    return tokens[i] === "^" ? (take(), v ** unary()) : v;
  }
  /** `%` 双语义：夹在两个操作数之间为取模（10 % 3），跟在操作数之后（后跟运算符或结尾）为百分比（200 × 10% = 20）
   *  加减号后的纯百分比带上下文：100 + 10% = 110，200 − 10% = 180 */
  function operandAt(j) {
    const t = tokens[j];
    return (
      t !== undefined &&
      (typeof t === "number" ||
        t === "(" ||
        (typeof t === "string" && /^[a-zπ]+$/i.test(t)))
    );
  }
  function product() {
    let v = unary();
    while (["*", "/", "%"].includes(tokens[i])) {
      if (tokens[i] === "%") {
        const next = tokens[i + 1];
        if (!operandAt(i + 1)) {
          take();
          v = v / 100;
          continue;
        }
      }
      const op = take();
      const r = unary();
      if (r === 0 && op !== "*") throw new Error("不能除以 0");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function sum() {
    let v = product();
    while (["+", "-"].includes(tokens[i])) {
      const op = take();
      // 上下文百分比：a + b%（b% 之后无操作数）→ a ± a×b/100
      if (
        typeof tokens[i] === "number" &&
        tokens[i + 1] === "%" &&
        [undefined, "+", "-", ")"].includes(tokens[i + 2])
      ) {
        const num = take();
        take();
        const r = (v * num) / 100;
        v = op === "+" ? v + r : v - r;
        continue;
      }
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const result = sum();
  if (i !== tokens.length) throw new Error("表达式不完整或缺少运算符");
  if (!Number.isFinite(result)) throw new Error("结果超出范围或函数定义域");
  return Object.is(result, -0) ? 0 : result;
}
export function formatNumber(value, precision = 12, opts = {}) {
  if (!Number.isFinite(value)) return String(value);
  if (opts.scientific)
    return value.toExponential(Math.max(0, Math.min(15, Number(precision) || 12) - 1));
  let s = String(
    Number(
      value.toPrecision(Math.max(3, Math.min(15, Number(precision) || 12))),
    ),
  );
  if (opts.group && !s.includes("e")) {
    const neg = s.startsWith("-");
    const body = neg ? s.slice(1) : s;
    const [int, frac] = body.split(".");
    s =
      (neg ? "-" : "") +
      int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
      (frac ? "." + frac : "");
  }
  return s;
}
