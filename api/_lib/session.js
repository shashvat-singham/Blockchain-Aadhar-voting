'use strict';

const { createHash } = require('node:crypto');
const { EncryptJWT, jwtDecrypt } = require('jose');
const { env } = require('./env');
const { unauthorized } = require('./http');

/**
 * Stateless tokens, encrypted rather than merely signed (JWE, dir + A256GCM).
 *
 * A signed JWT is public-readable, and these tokens carry an Aadhaar number
 * and the voter's nullifier -- the value that links a person to their on-chain
 * ballot. Encrypting means the browser holds an opaque blob and a token
 * captured in a log or a screenshot leaks nothing. A256GCM is authenticated,
 * so tampering is still detected.
 *
 * Two token types, kept apart by `aud` so an OTP challenge can never be
 * presented as a voting session:
 *
 *   otp-challenge : issued by /api/auth/request-otp, carries the OTP digest
 *   vote-session  : issued by /api/auth/verify-otp, authorises ballot casting
 *
 * Statelessness is safe because uniqueness is enforced on-chain: replaying a
 * session token cannot produce a second vote -- the contract rejects the
 * nullifier. Replay only wastes relayer gas, which the rate limiter caps.
 */

const ISSUER = 'aadhaar-voting';
const AUD_CHALLENGE = 'otp-challenge';
const AUD_SESSION = 'vote-session';

let cachedKey;
function encryptionKey() {
  if (!env.sessionSecret) {
    const error = new Error('SESSION_SECRET is not configured');
    error.statusCode = 503;
    error.code = 'NOT_CONFIGURED';
    throw error;
  }
  // A256GCM needs exactly 32 bytes; SHA-256 gives a stable key from any secret.
  if (!cachedKey) cachedKey = createHash('sha256').update(env.sessionSecret).digest();
  return cachedKey;
}

async function issue(payload, audience, ttlSeconds) {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(encryptionKey());
}

async function read(token, audience) {
  if (!token || typeof token !== 'string') throw unauthorized('Missing token');

  try {
    const { payload } = await jwtDecrypt(token, encryptionKey(), {
      issuer: ISSUER,
      audience,
      contentEncryptionAlgorithms: ['A256GCM'],
      keyManagementAlgorithms: ['dir'],
      clockTolerance: 5,
    });
    return payload;
  } catch (error) {
    if (error.code === 'ERR_JWT_EXPIRED') {
      throw unauthorized('Your session expired. Please start again.');
    }
    throw unauthorized('Invalid or tampered token');
  }
}

const issueChallengeToken = (claims) => issue(claims, AUD_CHALLENGE, env.otpTtlSeconds);
const readChallengeToken = (token) => read(token, AUD_CHALLENGE);

const issueSessionToken = (claims) => issue(claims, AUD_SESSION, env.sessionTtlSeconds);
const readSessionToken = (token) => read(token, AUD_SESSION);

/** Pulls a bearer token out of the Authorization header. */
function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Reads and validates the caller's voting session, or throws 401. */
async function requireSession(req) {
  const token = bearerToken(req);
  if (!token) throw unauthorized('Sign in with your Aadhaar number to continue');
  return readSessionToken(token);
}

module.exports = {
  issueChallengeToken,
  readChallengeToken,
  issueSessionToken,
  readSessionToken,
  requireSession,
  bearerToken,
  AUD_CHALLENGE,
  AUD_SESSION,
};
