import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const md5mod = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.hash/src/js/md5.mjs"))
);
const jwtmod = await import(
  pathToFileURL(resolve(root, "plugins/com.enest.hash/src/js/jwt.mjs"))
);

test("md5 matches RFC 1321 and long-input vectors", () => {
  assert.equal(md5mod.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5mod.md5("a"), "0cc175b9c0f1b6a831c399e269772661");
  assert.equal(md5mod.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5mod.md5("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
  assert.equal(md5mod.md5("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
  assert.equal(
    md5mod.md5("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
    "d174ab98d277d9f5a5611c2c9f419d9f",
  );
  assert.equal(
    md5mod.md5("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    "57edf4a22be3c955ac49da2e2107b67a",
  );
  // 多 chunk（跨 64 字节块）与 UTF-8 多字节
  assert.equal(md5mod.md5("中".repeat(100)).length, 32);
  assert.notEqual(md5mod.md5("中".repeat(100)), md5mod.md5("中".repeat(99)));
});

test("digest helpers cover SHA family via webcrypto", async () => {
  assert.equal(await md5mod.digestHex("SHA-256", "abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await md5mod.digestHex("SHA-1", "abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(await md5mod.digestHex("SHA-512", ""), "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e");
  const sha224 = await md5mod.digestHex("SHA-224", "abc");
  if (sha224) assert.equal(sha224, "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"); // 平台不支持 SHA-224 时 computeHash 返回 null，UI 已兜底
  assert.equal(md5mod.bytesToHex(new Uint8Array([0, 15, 255])), "000fff");
  const b64 = md5mod.bytesToBase64(new Uint8Array([104, 101, 108, 108, 111]));
  assert.equal(b64, "aGVsbG8=");
  assert.deepEqual([...md5mod.base64ToBytes("aGVsbG8=")], [104, 101, 108, 108, 111]);
  assert.deepEqual([...md5mod.base64ToBytes("aGVs bG8=")], [104, 101, 108, 108, 111]);
});

test("jwt decodes three-part tokens and annotates times", () => {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub: "1234567890", name: "eNest", iat: 1700000000, exp: 1800000000 };
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = `${b64url(header)}.${b64url(payload)}.sig-nature_1`;
  const decoded = jwtmod.decodeJwt(token);
  assert.deepEqual(decoded.header, header);
  assert.equal(decoded.payload.name, "eNest");
  assert.equal(decoded.signature, "sig-nature_1");
  const annotated = jwtmod.annotateTimes(decoded.payload, 1750000000000);
  assert.match(annotated.iat, /^2023-11-14T22:13:20/);
  assert.match(annotated.exp, /（未过期）$/);
  assert.match(jwtmod.annotateTimes({ exp: 1700000000 }, 1750000000000).exp, /（已过期）$/);

  assert.throws(() => jwtmod.decodeJwt("a.b"), /三段式/);
  assert.throws(() => jwtmod.decodeJwt("!!!.eyJhIjoxfQ.sig"), /header/);
  assert.throws(() => jwtmod.decodeJwt("eyJhbGciOiJIUzI1NiJ9.###.sig"), /payload/);
});

test("normalizeDigest tolerates case, separators and 0x prefix", () => {
  assert.equal(md5mod.normalizeDigest("BA7816BF-8F:01 CF EA 41 41 40 DE 5D AE 22 23").value, "ba7816bf8f01cfea414140de5dae2223");
  assert.equal(md5mod.normalizeDigest('"0XBa7816bf"').value, "ba7816bf");
  assert.equal(md5mod.normalizeDigest("ba7816bf").ok, true);
  assert.equal(md5mod.normalizeDigest("xyz").ok, false);
  assert.equal(md5mod.normalizeDigest("").ok, false);
  assert.equal(md5mod.normalizeDigest("  ").value, "");
});

test("compareDigest verdicts and first-mismatch index", () => {
  const actual = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  // 完全一致（含大小写与分隔符容忍）
  assert.equal(md5mod.compareDigest(actual, actual.toUpperCase()).equal, true);
  assert.equal(md5mod.compareDigest(actual, "BA78-16BF 8F01 CFEA").equal, false); // 长度不同，不算一致
  assert.equal(md5mod.compareDigest(actual, "0x" + actual).equal, true);
  // 逐字符定位
  const hit = md5mod.compareDigest(actual, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ae");
  assert.equal(hit.equal, false);
  assert.equal(hit.mismatch, 63);
  const lead = md5mod.compareDigest(actual, "ba7800" + actual.slice(6));
  assert.equal(lead.mismatch, 4);
  // 非法期望值
  assert.equal(md5mod.compareDigest(actual, "not-hex!").invalid, true);
  assert.equal(md5mod.compareDigest(actual, "").invalid, true);
});

test("diffSegments marks only the tail after first mismatch", () => {
  const actual = "aabbcc";
  const same = md5mod.diffSegments(actual, "AABBCC");
  assert.equal(same.equal, true);
  assert.deepEqual(same.segments, [{ text: "aabbcc", same: true }]);
  const diff = md5mod.diffSegments(actual, "aabbcd");
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.segments, [
    { text: "aabbc", same: true },
    { text: "d", same: false },
  ]);
  // 首位即不同：无相同前缀，整体标红（期望须为合法 hex）
  const lead = md5mod.diffSegments(actual, "00bbcc");
  assert.deepEqual(lead.segments, [{ text: "00bbcc", same: false }]);
  assert.equal(md5mod.diffSegments(actual, "zz!").invalid, true);
  assert.deepEqual(md5mod.diffSegments(actual, "zz!").segments, []);
});
