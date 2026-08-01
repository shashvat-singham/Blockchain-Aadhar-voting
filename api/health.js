'use strict';

const { route, sendJson } = require('./_lib/http');
const { env, configReport } = require('./_lib/env');
const { registryStatus } = require('./_lib/registry');
const { isDistributed } = require('./_lib/ratelimit');
const chain = require('./_lib/chain');

/**
 * GET /api/health
 *
 * An honest readiness probe. It reports what is actually wrong -- unset
 * variables, an unreachable RPC, an unauthorised or unfunded relayer -- rather
 * than a bare "ok", because on this app a silently broken relayer means
 * ballots stop being recorded.
 *
 * Returns 503 when the service cannot accept votes, so uptime monitoring
 * catches it. Secrets are never echoed; only their presence.
 */
async function get(req, res) {
  const config = configReport();
  const checks = {};
  const problems = [];

  // ---- configuration ---------------------------------------------------
  checks.config = { ok: config.ok, missing: config.missing, warnings: config.warnings };
  if (!config.ok) problems.push('configuration incomplete');

  // ---- electoral roll --------------------------------------------------
  const registry = registryStatus();
  checks.registry = registry;
  if (!registry.available) problems.push('voter registry unavailable');

  // ---- rate limiting ---------------------------------------------------
  checks.rateLimiter = {
    ok: true,
    mode: isDistributed() ? 'redis' : 'in-memory',
    note: isDistributed()
      ? undefined
      : 'Per-instance only. Set UPSTASH_REDIS_REST_URL/TOKEN for limits that hold across instances.',
  };

  // ---- chain + relayer -------------------------------------------------
  if (config.ok) {
    try {
      const [status, relayer] = await Promise.all([chain.electionStatus(), chain.relayerStatus()]);

      checks.chain = {
        ok: true,
        chainId: relayer.chainId,
        contractAddress: env.contractAddress,
        election: {
          name: status.name,
          phase: status.phase,
          isLive: status.isLive,
          paused: status.paused,
          candidates: status.candidateCount,
          totalVotes: status.totalVotes,
        },
      };

      checks.relayer = {
        ok: relayer.authorised && relayer.funded,
        address: relayer.address,
        authorised: relayer.authorised,
        funded: relayer.funded,
        balance: relayer.balanceEther,
      };

      if (env.chainId && relayer.chainId !== Number(env.chainId)) {
        problems.push(`RPC is on chain ${relayer.chainId} but CHAIN_ID says ${env.chainId}`);
        checks.chain.ok = false;
      }
      if (!relayer.authorised) {
        problems.push('relayer is not authorised by the contract (call setRelayer)');
      }
      if (!relayer.funded) {
        problems.push('relayer balance is below the minimum needed to pay for ballots');
      }
    } catch (error) {
      checks.chain = { ok: false, error: error.message };
      problems.push('cannot reach the election contract');
    }
  } else {
    checks.chain = { ok: false, skipped: 'configuration incomplete' };
  }

  const healthy = problems.length === 0;

  sendJson(res, healthy ? 200 : 503, {
    status: healthy ? 'ok' : 'degraded',
    canAcceptVotes: healthy,
    problems,
    checks,
    version: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    environment: env.isProduction ? 'production' : 'development',
  });
}

module.exports = route({ GET: get });
