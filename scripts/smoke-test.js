'use strict';

/**
 * End-to-end smoke test against a running stack.
 *
 *   npm run chain                 # terminal 1
 *   npm run deploy:local && npm run seed:local
 *   npm run voters:hash
 *   npm run smoke
 *
 * It invokes the real serverless handlers with mock req/res objects rather
 * than going over HTTP, so it covers the code Vercel actually runs without
 * needing `vercel dev` up. Read it as executable documentation of the flow:
 * identity -> one-time code -> ballot -> on-chain vote -> receipt.
 *
 * Every assertion here is a property the election depends on, including the
 * negative ones: a second ballot from the same voter must be refused by the
 * contract, not merely by the UI.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Loads .env.local without pulling in a dependency the production bundle does
 * not need. Existing environment variables always win.
 */
function loadEnvLocal() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const AADHAAR = process.env.SMOKE_AADHAAR || '300000000000';

/* ------------------------------------------------------------------ mocks */

function mockResponse() {
  const state = { statusCode: null, body: null, headers: {} };

  const response = {
    setHeader: (key, value) => {
      state.headers[key.toLowerCase()] = value;
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    end() {
      return this;
    },
    get headersSent() {
      return state.statusCode !== null;
    },
    _state: state,
  };

  return response;
}

async function call(handler, { method = 'GET', body, token } = {}) {
  const req = {
    method,
    url: '/smoke',
    headers: {
      'x-forwarded-for': '203.0.113.10',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    socket: { remoteAddress: '203.0.113.10' },
    body,
  };

  const res = mockResponse();
  await handler(req, res);
  return { status: res._state.statusCode, body: res._state.body };
}

/* --------------------------------------------------------------- reporting */

let passed = 0;
let failed = 0;

function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${description}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${description}`);
    if (detail !== undefined) console.error(`        ${JSON.stringify(detail)}`);
  }
}

const section = (title) => console.log(`\n${title}`);

/* ------------------------------------------------------------------- flow */

async function main() {
  const health = require('../api/health');
  const config = require('../api/config');
  const results = require('../api/results');
  const requestOtp = require('../api/auth/request-otp');
  const verifyOtp = require('../api/auth/verify-otp');
  const ballot = require('../api/ballot');
  const vote = require('../api/vote');

  section('Service health');
  const healthResult = await call(health);
  check('health endpoint responds 200', healthResult.status === 200, healthResult.body);
  check('service can accept votes', healthResult.body?.canAcceptVotes === true, healthResult.body?.problems);
  check('relayer is authorised by the contract', healthResult.body?.checks?.relayer?.authorised === true);
  check('relayer is funded', healthResult.body?.checks?.relayer?.funded === true);

  if (!healthResult.body?.canAcceptVotes) {
    console.error('\nStack is not ready; skipping the rest.');
    process.exit(1);
  }

  section('Public configuration');
  const configResult = await call(config);
  check('config exposes the contract address', Boolean(configResult.body?.chain?.contractAddress));
  check('config never leaks the private RPC', configResult.body?.chain?.rpcUrl !== process.env.RPC_URL || !process.env.RPC_URL.includes('key'));
  check('config exposes an ABI for independent verification', Array.isArray(configResult.body?.abi));

  section('Input validation');
  const badAadhaar = await call(requestOtp, { method: 'POST', body: { aadhaar: '12345' } });
  check('rejects a malformed Aadhaar number', badAadhaar.status === 400, badAadhaar.body);

  const notOnRoll = await call(requestOtp, { method: 'POST', body: { aadhaar: '899999999999' } });
  check('rejects a number that is not on the roll', notOnRoll.status === 403, notOnRoll.body);

  const wrongMethod = await call(vote, { method: 'GET' });
  check('rejects the wrong HTTP method', wrongMethod.status === 405, wrongMethod.body);

  const noAuth = await call(ballot);
  check('ballot requires a session', noAuth.status === 401, noAuth.body);

  section('Identity and one-time code');
  const otpResult = await call(requestOtp, { method: 'POST', body: { aadhaar: AADHAAR } });
  check('issues a challenge', otpResult.status === 200, otpResult.body);
  check('masks the phone number', /•/.test(otpResult.body?.phoneHint || ''), otpResult.body?.phoneHint);
  check('returns the voter constituency', Boolean(otpResult.body?.ward?.id));

  const otp = otpResult.body?.devOtp;
  if (!otp) {
    console.error('\nSet DEV_ECHO_OTP=true (and a non-production NODE_ENV) to run the full flow.');
    process.exit(1);
  }

  const wrongCode = await call(verifyOtp, {
    method: 'POST',
    body: { challengeToken: otpResult.body.challengeToken, otp: otp === '000000' ? '111111' : '000000' },
  });
  check('rejects an incorrect code', wrongCode.status === 401, wrongCode.body);

  const tamperedToken = await call(verifyOtp, {
    method: 'POST',
    body: { challengeToken: `${otpResult.body.challengeToken}x`, otp },
  });
  check('rejects a tampered challenge token', tamperedToken.status === 401, tamperedToken.body);

  const verified = await call(verifyOtp, {
    method: 'POST',
    body: { challengeToken: otpResult.body.challengeToken, otp },
  });
  check('accepts the correct code', verified.status === 200, verified.body);

  const sessionToken = verified.body?.sessionToken;
  check('issues a voting session', Boolean(sessionToken));

  // A challenge token must not be usable where a session token is expected.
  const crossUse = await call(ballot, { token: otpResult.body.challengeToken });
  check('challenge token cannot be used as a session', crossUse.status === 401, crossUse.body);

  section('Ballot');
  const ballotResult = await call(ballot, { token: sessionToken });
  check('returns the ballot', ballotResult.status === 200, ballotResult.body);
  check('ballot has candidates', (ballotResult.body?.candidates?.length || 0) > 0);
  check(
    'ballot is scoped to the voter constituency',
    ballotResult.body?.ward?.id === otpResult.body.ward.id,
    ballotResult.body?.ward
  );
  check(
    'ballot does not reveal running tallies',
    ballotResult.body?.candidates?.every((c) => c.votes === undefined)
  );

  const candidateId = ballotResult.body.candidates[0].id;

  section('Casting the vote (no wallet involved)');
  const before = await call(results);
  const votesBefore = before.body?.turnout?.totalVotes ?? 0;

  // Relayer balance before the ballot, so we can prove what it actually cost.
  const healthBefore = await call(health);
  const gasFree = healthBefore.body?.checks?.relayer?.gasFree === true;
  const balanceBefore = healthBefore.body?.checks?.relayer?.balance;

  const voteResult = await call(vote, { method: 'POST', body: { candidateId }, token: sessionToken });
  check('vote is recorded', voteResult.status === 200, voteResult.body);
  check('receipt carries a real transaction hash', /^0x[0-9a-f]{64}$/i.test(voteResult.body?.receipt?.txHash || ''));
  check('receipt carries a block number', Number.isInteger(voteResult.body?.receipt?.blockNumber));

  const healthAfter = await call(health);
  const balanceAfter = healthAfter.body?.checks?.relayer?.balance;

  if (gasFree) {
    // The whole point of a zero-fee chain: nobody paid anything for this vote.
    check('gas-free chain: the ballot cost the relayer nothing', balanceBefore === balanceAfter, {
      before: balanceBefore,
      after: balanceAfter,
    });
    console.log(`        relayer balance unchanged at ${balanceAfter}`);
  } else {
    check('sponsored gas: the relayer paid, not the voter', balanceBefore !== balanceAfter, {
      before: balanceBefore,
      after: balanceAfter,
    });
    console.log(`        relayer paid: ${balanceBefore} -> ${balanceAfter}`);
  }

  section('Double-vote prevention (enforced on-chain)');
  const secondVote = await call(vote, { method: 'POST', body: { candidateId }, token: sessionToken });
  check('a second ballot from the same voter is refused', secondVote.status === 409, secondVote.body);
  check('refusal names the reason', secondVote.body?.error?.details?.reason === 'ALREADY_VOTED', secondVote.body);

  const otherCandidate = ballotResult.body.candidates[1]?.id;
  if (otherCandidate !== undefined) {
    const switched = await call(vote, {
      method: 'POST',
      body: { candidateId: otherCandidate },
      token: sessionToken,
    });
    check('switching candidate does not grant a second vote', switched.status === 409, switched.body);
  }

  const reAuth = await call(requestOtp, { method: 'POST', body: { aadhaar: AADHAAR } });
  check('a voter who has voted cannot request a new code', reAuth.status === 409, reAuth.body);

  section('Results');
  const after = await call(results);
  check('results respond 200', after.status === 200, after.status);
  check(
    'turnout increased by exactly one',
    after.body?.turnout?.totalVotes === votesBefore + 1,
    { before: votesBefore, after: after.body?.turnout?.totalVotes }
  );
  check('results expose verification details', Boolean(after.body?.verification?.contractAddress));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
