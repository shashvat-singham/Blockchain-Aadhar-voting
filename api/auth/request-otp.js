'use strict';

const { randomUUID } = require('node:crypto');
const { route, readJsonBody, sendJson, clientIp, badRequest, forbidden, conflict } = require('../_lib/http');
const { env } = require('../_lib/env');
const { normaliseAadhaar, generateOtp, otpDigest, nullifierFor, maskPhone } = require('../_lib/crypto');
const { findVoter } = require('../_lib/registry');
const { issueChallengeToken } = require('../_lib/session');
const { enforce } = require('../_lib/ratelimit');
const { sendOtp } = require('../_lib/sms');
const chain = require('../_lib/chain');
const { wardLabel } = require('../_lib/election-config');

/**
 * POST /api/auth/request-otp
 * Body: { aadhaar: "300000000000" }
 *
 * Verifies the number against the electoral roll and texts a one-time code to
 * the registered mobile. Returns an encrypted challenge token that
 * /api/auth/verify-otp consumes.
 *
 * Delivery is server-side; the browser never sees an SMS provider, an API key,
 * or (outside dev mode) the code itself.
 */
async function post(req, res) {
  const ip = clientIp(req);
  const body = readJsonBody(req);

  // Cheapest limit first: cap an abusive source before touching the roll.
  await enforce(
    'otp-request-ip',
    ip,
    { limit: 10, windowSeconds: 3600 },
    'Too many verification attempts from this network. Please try again later.'
  );

  const aadhaar = normaliseAadhaar(body.aadhaar);
  if (!aadhaar) {
    throw badRequest('Enter a valid 12-digit Aadhaar number.');
  }

  // Per-number limit, so one voter cannot be spammed with texts from many IPs.
  await enforce(
    'otp-request-voter',
    nullifierFor(aadhaar),
    { limit: 5, windowSeconds: 3600 },
    'Too many codes requested for this Aadhaar number. Please try again in an hour.'
  );

  const voter = findVoter(aadhaar);
  if (!voter) {
    // Deliberately explicit: a voter who is not on the roll needs to know to go
    // and register. Enumeration is impractical against a 10^12 space at 10
    // attempts per hour per network.
    throw forbidden('This Aadhaar number is not on the electoral roll for this election.');
  }
  if (!voter.eligible) {
    throw forbidden('This Aadhaar number is not eligible to vote in this election.');
  }
  if (!voter.phone) {
    throw forbidden('No mobile number is linked to this Aadhaar number. Contact your returning officer.');
  }

  // Check the chain before spending an SMS on someone who has already voted.
  const nullifier = nullifierFor(aadhaar);
  if (await chain.hasVoted(nullifier)) {
    throw conflict('A ballot has already been cast with this Aadhaar number.', { reason: 'ALREADY_VOTED' });
  }

  const status = await chain.electionStatus();
  if (!status.isLive) {
    throw conflict(
      status.phaseId === 2 ? 'Polling has closed for this election.' : 'Polling is not open yet.',
      { reason: 'NOT_LIVE', phase: status.phase }
    );
  }

  const challengeId = randomUUID();
  const otp = generateOtp();

  const delivery = await sendOtp(voter.phone, otp);

  // The digest is an HMAC under SESSION_SECRET, so shipping it inside the
  // token gives a client nothing to brute-force offline.
  const challengeToken = await issueChallengeToken({
    cid: challengeId,
    sub: aadhaar,
    ward: voter.ward,
    dig: otpDigest(otp, challengeId),
  });

  sendJson(res, 200, {
    challengeToken,
    challengeId,
    expiresInSeconds: env.otpTtlSeconds,
    maxAttempts: env.otpMaxAttempts,
    phoneHint: maskPhone(voter.phone),
    ward: { id: voter.ward, label: wardLabel(voter.ward) },
    // Present only when DEV_ECHO_OTP is on and we are not in production.
    devOtp: delivery.echoed ? otp : undefined,
  });
}

module.exports = route({ POST: post });
