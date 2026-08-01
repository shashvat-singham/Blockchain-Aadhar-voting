'use strict';

const { route, sendJson } = require('./_lib/http');
const { env } = require('./_lib/env');
const { wardLabel, symbolFor } = require('./_lib/election-config');
const chain = require('./_lib/chain');

/**
 * GET /api/results
 *
 * Public tallies, read straight from the contract and grouped by ward.
 *
 * Under the default RESULTS_VISIBILITY=after-close, counts are withheld until
 * the authority closes the election -- a visible running total steers the
 * voters who have not been yet. Turnout is always published, because it is
 * an integrity signal and reveals nothing about anyone's choice.
 *
 * The numbers are on a public chain either way: this endpoint is a
 * convenience, not a secrecy mechanism, and the page says so.
 */
async function get(req, res) {
  const [status, candidates] = await Promise.all([chain.electionStatus(), chain.allCandidates()]);

  const tallyVisible = env.resultsVisibility === 'live' || status.phaseId === 2;

  const byWard = new Map();
  for (const candidate of candidates) {
    if (!byWard.has(candidate.ward)) {
      byWard.set(candidate.ward, { id: candidate.ward, label: wardLabel(candidate.ward), candidates: [] });
    }
    byWard.get(candidate.ward).candidates.push({
      id: candidate.id,
      name: candidate.name,
      party: candidate.party,
      symbolUri: candidate.symbolUri || symbolFor(candidate.ward, candidate.name),
      active: candidate.active,
      votes: tallyVisible ? candidate.voteCount : null,
    });
  }

  const wards = [...byWard.values()].map((ward) => {
    const votes = ward.candidates.reduce((sum, c) => sum + (c.votes || 0), 0);

    if (tallyVisible) {
      ward.candidates.sort((a, b) => b.votes - a.votes);
      // A tie has no winner; declaring one would be wrong.
      const [first, second] = ward.candidates;
      ward.leader = first && (!second || first.votes > second.votes) && first.votes > 0 ? first.name : null;
    } else {
      ward.candidates.sort((a, b) => a.name.localeCompare(b.name));
      ward.leader = null;
    }

    return { ...ward, totalVotes: tallyVisible ? votes : null };
  });

  sendJson(res, 200, {
    election: {
      name: status.name,
      phase: status.phase,
      opensAt: status.opensAt,
      closesAt: status.closesAt,
      isLive: status.isLive,
    },
    // Turnout is published in every phase; per-candidate counts may not be.
    turnout: { totalVotes: status.totalVotes },
    tallyVisible,
    tallyWithheldReason: tallyVisible ? null : 'Counts are published when the election authority closes polling.',
    wards,
    verification: {
      contractAddress: env.contractAddress || null,
      chainId: env.chainId || null,
      rpcUrl: env.publicRpcUrl || null,
      explorerAddressUrl: env.explorerTxUrl ? env.explorerTxUrl.replace(/\/tx\/?$/, '/address') : null,
      note: 'These figures are read from the contract. Anyone can reproduce them from a public RPC without a wallet.',
    },
  });
}

module.exports = route({ GET: get });
