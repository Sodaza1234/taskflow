// @ts-check
import crypto from "node:crypto";

/**
 * @param {number} n
 */
function randomHex(n) {
  return crypto.randomBytes(n).toString("hex");
}

/** @returns {string} */
export function newId() {
  return crypto.randomUUID();
}

/**
 * @param {string} password
 * @param {string} saltHex
 */
export function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const hash = crypto.scryptSync(password, salt, 32);
  return hash.toString("hex");
}

/**
 * @param {string} password
 * @returns {{ salt: string, passwordHash: string }}
 */
export function makePassword(password) {
  const salt = randomHex(16);
  const passwordHash = hashPassword(password, salt);
  return { salt, passwordHash };
}

/**
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * @param {string} aHex
 * @param {string} bHex
 * @returns {boolean}
 */
export function safeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
