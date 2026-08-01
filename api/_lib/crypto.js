'use strict';

const crypto = require('node:crypto');
const { env } = require('./env');

/**
 * All keyed hashing for the app lives here so the domain separation strings
 * are visible in one place. Three independent secrets are used on purpose:
 *
 *   AADHAAR_PEPPER    -> registry lookup key (can be rotated with the roll)
 *   NULLIFIER_SECRET  -> on-chain voter identifier (rotating it voids the roll
 *                        of "already voted" markers, so it must NOT change
 *                        mid-election)
 *   SESSION_SECRET    -> JWT signing (rotating it just logs everyone out)
 *
 * Leaking one does not compromise the others.
 */

function hmac(secret, domain, value) {
  return crypto.createHmac('sha256', secret).update(domain).update('\x1f').update(value).digest();
}

/** Stable lookup key for the electoral roll. Never store raw Aadhaar numbers. */
function registryKey(aadhaar) {
  return hmac(env.aadhaarPepper, 'aadhaar-registry:v1', aadhaar).toString('hex');
}

/**
 * The voter's on-chain identity: a bytes32 that is deterministic per person
 * but reveals nothing about them without NULLIFIER_SECRET.
 */
function nullifierFor(aadhaar) {
  return `0x${hmac(env.nullifierSecret, 'aadhaar-nullifier:v1', aadhaar).toString('hex')}`;
}

/** bytes32 encoding of a ward id, matching `ethers.encodeBytes32String`. */
function wardToBytes32(wardId) {
  const bytes = Buffer.from(String(wardId), 'utf8');
  if (bytes.length > 31) {
    throw new Error(`Ward id "${wardId}" exceeds 31 bytes and cannot be encoded as bytes32`);
  }
  return `0x${Buffer.concat([bytes], 32).toString('hex')}`;
}

/** Cryptographically uniform numeric OTP, free of modulo bias. */
function generateOtp(length = env.otpLength) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += String(crypto.randomInt(0, 10));
  }
  return code;
}

/** Binds an OTP to one challenge so a code cannot be replayed on another. */
function otpDigest(otp, challengeId) {
  return hmac(env.sessionSecret, 'otp-digest:v1', `${challengeId}:${otp}`).toString('hex');
}

/** Length-safe constant-time comparison. */
function timingSafeEqual(a, b) {
  const bufferA = Buffer.from(String(a), 'utf8');
  const bufferB = Buffer.from(String(b), 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the failure path costs the same.
    crypto.timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Normalises an Aadhaar number to 12 bare digits.
 *
 * Real UIDAI numbers never begin with 0 or 1, but that rule is only used as a
 * typo hint, not a gate: the electoral roll is the authority on who may vote,
 * and a number that appears on it is valid by definition. Enforcing the
 * convention here would make the roll and the validator disagree, and would
 * reject the synthetic numbers used for testing and training.
 */
function normaliseAadhaar(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const digits = String(input).replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(digits)) return null;
  return digits;
}

/** True when a number breaks the UIDAI leading-digit convention. */
const looksSynthetic = (aadhaar) => /^[01]/.test(aadhaar);

/** "+919876543210" -> "+91 ••••• 3210" for display in the OTP screen. */
function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 4) return '••••';
  const country = value.startsWith('+') ? value.slice(0, 3) : '';
  return `${country} ••••• ${value.slice(-4)}`.trim();
}

module.exports = {
  registryKey,
  nullifierFor,
  wardToBytes32,
  generateOtp,
  otpDigest,
  timingSafeEqual,
  normaliseAadhaar,
  looksSynthetic,
  maskPhone,
};
