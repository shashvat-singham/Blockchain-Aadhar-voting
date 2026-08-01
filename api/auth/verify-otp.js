'use strict';

const { route, readJsonBody, sendJson, clientIp, badRequest, unauthorized, conflict } = require('../_lib/http');
const { env } = require('../_lib/env');
const { otpDigest, timingSafeEqual, nullifierFor } = require('../_lib/crypto');
const { readChallengeToken, issueSessionToken } = require('../_lib/session');
const { enforce } = require('../_lib/ratelimit');
const { wardLabel } = require('../_lib/election-config');
const chain = require('../_lib/chain');

/**
 * POST /api/auth/verify-otp
 * Body: { challengeToken, otp }
 *
 * Exchanges a correct one-time code for a short-lived voting session.
 *
 * The challenge token is stateless, so attempt counting lives in the rate
 * limiter keyed by challenge id rather than in the token itself -- a client
 * cannot rewind its own attempt counter by resending an older copy.
 */
async function post(req, res) {
  const body = readJsonBody(req);

  await enforce(
    'otp-verify-ip',
    clientIp(req),
    { limit: 30, windowSeconds: 3600 },
    'Too many verification attempts from this network. Please try again later.'
  );

  if (typeof body.otp !== 'string' || !/^\d{4,8}$/.test(body.otp.trim())) {
    throw badRequest('Enter the numeric code sent to your registered mobile number.');
  }

  const claims = await readChallengeToken(body.challengeToken);
  const { cid, sub: aadhaar, ward, dig } = claims;
  if (!cid || !aadhaar || !ward || !dig) {
    throw unauthorized('Malformed challenge. Please request a new code.');
  }

  await enforce(
    'otp-verify-challenge',
    cid,
    { limit: env.otpMaxAttempts, windowSeconds: env.otpTtlSeconds },
    'Too many incorrect codes. Please request a new one.'
  );

  if (!timingSafeEqual(otpDigest(body.otp.trim(), cid), dig)) {
    throw unauthorized('That code is not correct. Please check and try again.');
  }

  // Re-check on-chain: the voter may have completed a ballot in another tab
  // between requesting the code and entering it.
  const nullifier = nullifierFor(aadhaar);
  if (await chain.hasVoted(nullifier)) {
    throw conflict('A ballot has already been cast with this Aadhaar number.', { reason: 'ALREADY_VOTED' });
  }

  // The nullifier is carried in the session so /api/vote never needs the
  // Aadhaar number again. The token is encrypted, so it stays server-only.
  const sessionToken = await issueSessionToken({ sub: nullifier, ward });

  sendJson(res, 200, {
    sessionToken,
    expiresInSeconds: env.sessionTtlSeconds,
    ward: { id: ward, label: wardLabel(ward) },
  });
}

module.exports = route({ POST: post });
