export const CHARACTER_SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  symbol: "!@#$%^&*_-+=?",
};
export function randomBelow(max, rng = crypto) {
  if (!Number.isInteger(max) || max < 1 || max > 0xffffffff)
    throw new Error("随机范围无效");
  const limit = Math.floor(0x100000000 / max) * max,
    bytes = new Uint32Array(1);
  do {
    rng.getRandomValues(bytes);
  } while (bytes[0] >= limit);
  return bytes[0] % max;
}
export function passwordPools({
  sets = Object.keys(CHARACTER_SETS),
  exclude = "",
  avoidAmbiguous = false,
} = {}) {
  const excluded = new Set(exclude + (avoidAmbiguous ? "O0oIl1|" : ""));
  if (!sets.length) throw new Error("至少选择一种字符集");
  const pools = sets.map((name) => {
    if (!CHARACTER_SETS[name]) throw new Error("未知字符集");
    const pool = [...CHARACTER_SETS[name]].filter((c) => !excluded.has(c));
    if (!pool.length) throw new Error("排除字符后「" + name + "」为空");
    return pool;
  });
  return pools;
}
export function generatePassword(options = {}, rng = crypto) {
  const pools = passwordPools(options),
    length = Number(options.length ?? 16);
  if (!Number.isInteger(length) || length < 6 || length > 128)
    throw new Error("长度应为 6–128 的整数");
  const all = pools.flat(),
    output = pools.map((pool) => pool[randomBelow(pool.length, rng)]);
  while (output.length < length) output.push(all[randomBelow(all.length, rng)]);
  for (let i = output.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1, rng);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output.join("");
}
export function uuidV4(
  { uppercase = false, hyphens = true } = {},
  rng = crypto,
) {
  const bytes = new Uint8Array(16);
  rng.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  if (hyphens)
    value = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return uppercase ? value.toUpperCase() : value;
}
export function entropyEstimate(options) {
  const pools = passwordPools(options);
  return Math.floor(
    Number(options.length || 16) * Math.log2(pools.flat().length),
  );
}
