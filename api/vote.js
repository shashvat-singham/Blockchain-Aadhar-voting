'use strict';

const { route, readJsonBody, sendJson, clientIp, badRequest } = require('./_lib/http');
const { env } = require('./_lib/env');
const { requireSession } = require('./_lib/session');
const { wardToBytes32 } = require('./_lib/crypto');
const { enforce } = require('./_lib/ratelimit');
const chain = require('./_lib/chain');

/**
 * POST /api/vote
 * Header: Authorization: Bearer <sessionToken>
 * Body:   { candidateId: 0 }
 *
 * Casts the ballot on-chain. The relayer signs and pays the gas, so the voter
 * needs no wallet, no browser extension and no cryptocurrency -- the whole
 * reason MetaMask was removed.
 *
 * The response is a real transaction hash: the voter can verify their ballot
 * on a public block explorer without installing anything.
 */
async function post(req, res) {
  const { sub: nullifier, ward } = await requireSession(req);
  const body = readJsonBody(req);

  // Two limits: the voter (cheap retries after a network blip are fine, floods
  // are not) and the network (one host must not drain the relayer's gas).
  await enforce(
    'vote-voter',
    nullifier,
    { limit: 5, windowSeconds: 600 },
    'Too many submissions. Please wait a moment and try again.'
  );
  await enforce('vote-ip', clientIp(req), { limit: 60, windowSeconds: 3600 });

  const candidateId = Number(body.candidateId);
  if (!Number.isInteger(candidateId) || candidateId < 0) {
    throw badRequest('Select a candidate before submitting your vote.');
  }

  // Every remaining rule -- already voted, polls closed, wrong ward, withdrawn
  // candidate -- is enforced by the contract and surfaced as a typed error.
  const receipt = await chain.sendVote({
    nullifier,
    candidateId,
    ward: wardToBytes32(ward),
  });

  sendJson(res, 200, {
    status: 'recorded',
    receipt: {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmations: env.confirmations,
      explorerUrl: env.explorerTxUrl ? `${env.explorerTxUrl.replace(/\/$/, '')}/${receipt.txHash}` : null,
    },
  });
}

module.exports = route({ POST: post });
