'use strict';

const { ethers } = require('ethers');
const { env, assertConfigured } = require('./env');
const { AADHAAR_VOTING_ABI, PHASE } = require('./abi');
const { ApiError, conflict, unavailable } = require('./http');

/**
 * The blockchain layer -- and the whole reason MetaMask is gone.
 *
 * Voters have no wallet and no funds. A single relayer key held by this
 * backend signs and pays for every ballot. The chain still owns the two
 * properties that matter: the tally is public and append-only, and one voter
 * can only ever vote once (enforced by the nullifier mapping, not by us).
 *
 * Concurrency note: several serverless instances may sign at the same moment
 * and race for the same nonce. `sendVote` handles that by simulating first,
 * then retrying nonce/underpriced failures with a fresh nonce and jittered
 * backoff. A high-volume deployment should instead front this with a single
 * sequencer or a managed relay service.
 */

let providerCache;
let relayerCache;

function provider() {
  if (!providerCache) {
    assertConfigured();
    providerCache = new ethers.JsonRpcProvider(
      env.rpcUrl,
      env.chainId ? Number(env.chainId) : undefined,
      // The chain id never changes under us, so skip re-detection per call.
      { staticNetwork: true, batchMaxCount: 1 }
    );
  }
  return providerCache;
}

function relayer() {
  if (!relayerCache) {
    assertConfigured();
    try {
      relayerCache = new ethers.Wallet(env.relayerPrivateKey, provider());
    } catch {
      throw unavailable('RELAYER_PRIVATE_KEY is not a valid private key');
    }
  }
  return relayerCache;
}

/** Read-only contract handle. Never signs, never spends. */
function readContract() {
  assertConfigured();
  return new ethers.Contract(env.contractAddress, AADHAAR_VOTING_ABI, provider());
}

/** Signing contract handle. Every call here costs the relayer gas. */
function writeContract() {
  assertConfigured();
  return new ethers.Contract(env.contractAddress, AADHAAR_VOTING_ABI, relayer());
}

const relayerAddress = () => relayer().address;

/* ------------------------------------------------------------------------ */
/*                            Error translation                             */
/* ------------------------------------------------------------------------ */

/** Digs the revert payload out of the several shapes ethers/RPCs produce. */
function extractRevertData(error) {
  return (
    error?.data ??
    error?.info?.error?.data ??
    error?.error?.data ??
    error?.transaction?.data ??
    null
  );
}

/**
 * Turns a contract revert into an ApiError with a message that means something
 * to the person at the terminal.
 */
function translateRevert(error) {
  const iface = new ethers.Interface(AADHAAR_VOTING_ABI);

  let name = error?.revert?.name;
  let args = error?.revert?.args;

  if (!name) {
    const data = extractRevertData(error);
    if (typeof data === 'string' && data.length >= 10) {
      try {
        const parsed = iface.parseError(data);
        name = parsed?.name;
        args = parsed?.args;
      } catch {
        /* not one of ours; fall through to the generic message */
      }
    }
  }

  switch (name) {
    case 'AlreadyVoted':
      return conflict('This voter has already cast a ballot in this election.', { reason: 'ALREADY_VOTED' });
    case 'VotingNotStarted':
      return new ApiError(409, 'VOTING_NOT_STARTED', 'Polling has not opened yet.');
    case 'VotingEnded':
      return new ApiError(409, 'VOTING_ENDED', 'Polling has closed.');
    case 'IsPaused':
      return new ApiError(503, 'VOTING_PAUSED', 'Voting is temporarily paused by the election authority.');
    case 'WrongPhase':
      return new ApiError(
        409,
        'WRONG_PHASE',
        `The election is not accepting ballots (current phase: ${PHASE[Number(args?.[1] ?? 0)] || 'unknown'}).`
      );
    case 'WardMismatch':
      return new ApiError(400, 'WARD_MISMATCH', 'That candidate is not contesting in your constituency.');
    case 'CandidateInactive':
      return new ApiError(409, 'CANDIDATE_INACTIVE', 'That candidate has withdrawn from the election.');
    case 'UnknownCandidate':
      return new ApiError(400, 'UNKNOWN_CANDIDATE', 'That candidate does not exist on this ballot.');
    case 'NotRelayer':
      return unavailable(
        'This backend is not authorised to submit ballots. The election authority must call setRelayer().'
      );
    case 'ZeroNullifier':
      return new ApiError(400, 'BAD_REQUEST', 'Malformed voter identifier.');
    default:
      return null;
  }
}

/** Non-revert infrastructure failures worth retrying with a new nonce. */
function isRetryableSendError(error) {
  const code = error?.code;
  const message = String(error?.shortMessage || error?.message || '').toLowerCase();

  if (code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED') return true;
  if (code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT') return true;

  return (
    message.includes('nonce too low') ||
    message.includes('already known') ||
    message.includes('replacement transaction underpriced') ||
    message.includes('known transaction')
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------------ */
/*                                 Ballots                                  */
/* ------------------------------------------------------------------------ */

const MAX_SEND_ATTEMPTS = 3;

/** True when the chain charges nothing, so ballots are free to submit. */
const isGasFree = () => env.gasPriceWei !== undefined && BigInt(env.gasPriceWei) === 0n;

/**
 * Fee overrides for a ballot transaction.
 *
 * With GAS_PRICE_WEI set we send a legacy (type-0) transaction at exactly that
 * price. On a zero-fee chain that means the ballot costs literally nothing --
 * the relayer's balance does not move, so it never needs funding and can never
 * run dry mid-election. Left unset, the node quotes the market rate as usual.
 */
function feeOverrides() {
  if (env.gasPriceWei === undefined) return {};
  return { gasPrice: BigInt(env.gasPriceWei) };
}

/**
 * Submits one ballot, paying gas from the relayer account.
 *
 * @param {{ nullifier: string, candidateId: number|bigint, ward: string }} ballot
 * @returns {Promise<{ txHash: string, blockNumber: number, gasUsed: string }>}
 */
async function sendVote({ nullifier, candidateId, ward }) {
  const contract = writeContract();
  const args = [nullifier, candidateId, ward];

  // Simulate first. A rejected ballot (already voted, polls closed, wrong ward)
  // costs nothing and returns a precise reason instead of an on-chain failure
  // the voter has to pay for in confusion.
  try {
    await contract.castVote.staticCall(...args);
  } catch (error) {
    const translated = translateRevert(error);
    if (translated) throw translated;
    console.error('Ballot simulation failed for an unrecognised reason:', error);
    throw unavailable('Could not reach the election contract. Please try again.');
  }

  let gasLimit;
  try {
    const estimate = await contract.castVote.estimateGas(...args, feeOverrides());
    // 25% headroom: the ballot may land in a block where another vote has
    // already touched the same storage slots.
    gasLimit = (estimate * 125n) / 100n;
  } catch {
    gasLimit = 250_000n; // measured worst case is well under this
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      // Re-read the nonce each attempt: a concurrent instance may have taken it.
      const nonce = await provider().getTransactionCount(relayerAddress(), 'pending');
      const tx = await contract.castVote(...args, { gasLimit, nonce, ...feeOverrides() });

      const receipt = await tx.wait(env.confirmations, env.txTimeoutMs);
      if (!receipt) throw new Error('Transaction receipt was not returned');
      if (receipt.status !== 1) throw new Error(`Transaction reverted on-chain (${tx.hash})`);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      lastError = error;

      const translated = translateRevert(error);
      if (translated) throw translated; // a real rejection, not worth retrying

      if (attempt < MAX_SEND_ATTEMPTS && isRetryableSendError(error)) {
        // Jitter so racing instances do not retry in lockstep.
        await sleep(150 * attempt + Math.floor(Math.random() * 200));
        continue;
      }
      break;
    }
  }

  console.error('Ballot submission failed after retries:', lastError);
  throw unavailable('The ballot could not be recorded on the blockchain. Please try again.');
}

/* ------------------------------------------------------------------------ */
/*                                  Reads                                   */
/* ------------------------------------------------------------------------ */

/** Has this voter already voted, according to the chain? */
async function hasVoted(nullifier) {
  return readContract().nullifierUsed(nullifier);
}

/**
 * Election header shown on every page.
 *
 * `isLive` comes from the contract's own `isVotingLive()` rather than being
 * recomputed here from `Date.now()`. The contract enforces the polling window
 * against `block.timestamp`, which is a different clock from this server's --
 * they drift, and a chain's timestamp can sit seconds or minutes ahead. Judging
 * liveness locally means the API can refuse a ballot the contract would have
 * accepted, or promise one it is about to reject.
 */
async function electionStatus() {
  const contract = readContract();

  const [status, isLive] = await Promise.all([contract.electionStatus(), contract.isVotingLive()]);
  const [name, phase, opensAt, closesAt, totalVotes, candidateCount, paused] = status;

  return {
    name,
    phase: PHASE[Number(phase)] || 'Unknown',
    phaseId: Number(phase),
    opensAt: Number(opensAt),
    closesAt: Number(closesAt),
    totalVotes: Number(totalVotes),
    candidateCount: Number(candidateCount),
    paused,
    isLive,
  };
}

function mapCandidate(id, raw) {
  return {
    id: Number(id),
    name: raw.name,
    party: raw.party,
    symbolUri: raw.symbolUri,
    ward: ethers.decodeBytes32String(raw.ward),
    active: raw.active,
    voteCount: Number(raw.voteCount),
  };
}

async function candidatesForWard(wardBytes32) {
  const [ids, list] = await readContract().getCandidatesByWard(wardBytes32);
  return list.map((raw, index) => mapCandidate(ids[index], raw));
}

async function allCandidates() {
  const list = await readContract().getCandidates();
  return list.map((raw, index) => mapCandidate(index, raw));
}

/** Relayer health: can it still pay for ballots? */
async function relayerStatus() {
  const address = relayerAddress();
  const [balance, authorised, network] = await Promise.all([
    provider().getBalance(address),
    readContract().isRelayer(address),
    provider().getNetwork(),
  ]);

  const gasFree = isGasFree();
  const minimum = BigInt(env.relayerMinBalanceWei);

  return {
    address,
    authorised,
    balanceWei: balance.toString(),
    balanceEther: ethers.formatEther(balance),
    // On a zero-fee chain a balance of 0 is perfectly healthy: ballots cost
    // nothing, so there is nothing to run out of.
    funded: gasFree || balance >= minimum,
    gasFree,
    chainId: Number(network.chainId),
  };
}

module.exports = {
  isGasFree,
  provider,
  readContract,
  writeContract,
  relayerAddress,
  sendVote,
  hasVoted,
  electionStatus,
  candidatesForWard,
  allCandidates,
  relayerStatus,
  translateRevert,
  PHASE,
};
