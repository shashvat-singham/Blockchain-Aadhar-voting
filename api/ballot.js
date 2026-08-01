'use strict';

const { route, sendJson, conflict } = require('./_lib/http');
const { requireSession } = require('./_lib/session');
const { wardToBytes32 } = require('./_lib/crypto');
const { wardLabel, symbolFor } = require('./_lib/election-config');
const chain = require('./_lib/chain');

/**
 * GET /api/ballot
 * Header: Authorization: Bearer <sessionToken>
 *
 * The authenticated voter's ballot paper: exactly the candidates contesting
 * their constituency, read live from the contract.
 *
 * Live tallies are omitted here on purpose -- showing running totals on the
 * voting screen influences the vote being cast. They are public on
 * /api/results once polling closes.
 */
async function get(req, res) {
  const { sub: nullifier, ward } = await requireSession(req);

  if (await chain.hasVoted(nullifier)) {
    throw conflict('A ballot has already been cast with this Aadhaar number.', { reason: 'ALREADY_VOTED' });
  }

  const status = await chain.electionStatus();
  if (!status.isLive) {
    throw conflict(status.phaseId === 2 ? 'Polling has closed.' : 'Polling is not open yet.', {
      reason: 'NOT_LIVE',
      phase: status.phase,
    });
  }

  const candidates = await chain.candidatesForWard(wardToBytes32(ward));

  sendJson(res, 200, {
    election: { name: status.name, phase: status.phase, closesAt: status.closesAt },
    ward: { id: ward, label: wardLabel(ward) },
    candidates: candidates
      .filter((candidate) => candidate.active)
      .map(({ id, name, party, symbolUri }) => ({
        id,
        name,
        party,
        // Prefer the on-chain URI; fall back to the local config's image.
        symbolUri: symbolUri || symbolFor(ward, name),
      })),
  });
}

module.exports = route({ GET: get });
