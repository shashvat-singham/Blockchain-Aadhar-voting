'use strict';

const { route, sendJson } = require('./_lib/http');
const { env } = require('./_lib/env');
const { AADHAAR_VOTING_ABI } = require('./_lib/abi');

/**
 * GET /api/config
 *
 * Everything the browser needs, and nothing it does not. Only values that are
 * already public go out here: the contract address, the chain id, a read-only
 * RPC and the ABI.
 *
 * This is what makes the app independently auditable without a wallet. A
 * visitor can point any read-only client at the same address and confirm the
 * published tally. No key, no extension, no funds.
 */
async function get(req, res) {
  sendJson(res, 200, {
    chain: {
      chainId: env.chainId || null,
      contractAddress: env.contractAddress || null,
      // Deliberately not RPC_URL: that one may carry an API key in its path.
      rpcUrl: env.publicRpcUrl || null,
      explorerTxUrl: env.explorerTxUrl || null,
      explorerAddressUrl: env.explorerTxUrl
        ? env.explorerTxUrl.replace(/\/tx\/?$/, '/address')
        : null,
    },
    abi: AADHAAR_VOTING_ABI,
    auth: {
      otpLength: env.otpLength,
      otpTtlSeconds: env.otpTtlSeconds,
      sessionTtlSeconds: env.sessionTtlSeconds,
    },
    resultsVisibility: env.resultsVisibility,
  });
}

module.exports = route({ GET: get });
