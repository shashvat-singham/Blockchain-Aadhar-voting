'use strict';

/**
 * ABI for AadhaarVoting, in ethers' human-readable form.
 *
 * Kept as source rather than a build artifact so the serverless functions have
 * no dependency on `hardhat compile` having run at deploy time. `npm run
 * deploy:*` re-checks this list against the freshly compiled artifact and
 * fails loudly if the two have drifted.
 *
 * Custom errors are included so relayer failures decode into messages a poll
 * worker can act on ("this voter has already voted") instead of a raw 0x hex
 * selector.
 */

const CANDIDATE_TUPLE =
  'tuple(string name, string party, string symbolUri, bytes32 ward, bool active, uint256 voteCount)';

const AADHAAR_VOTING_ABI = [
  // --- reads ---
  'function electionName() view returns (string)',
  'function phase() view returns (uint8)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function opensAt() view returns (uint64)',
  'function closesAt() view returns (uint64)',
  'function totalVotes() view returns (uint256)',
  'function isRelayer(address) view returns (bool)',
  'function nullifierUsed(bytes32) view returns (bool)',
  'function wardTurnout(bytes32) view returns (uint256)',
  'function candidateCount() view returns (uint256)',
  `function getCandidate(uint256 candidateId) view returns (${CANDIDATE_TUPLE})`,
  `function getCandidates() view returns (${CANDIDATE_TUPLE}[])`,
  `function getCandidatesByWard(bytes32 ward) view returns (uint256[] ids, ${CANDIDATE_TUPLE}[] list)`,
  'function isVotingLive() view returns (bool)',
  'function electionStatus() view returns (string name_, uint8 phase_, uint64 opensAt_, uint64 closesAt_, uint256 totalVotes_, uint256 candidateCount_, bool paused_)',

  // --- writes ---
  'function castVote(bytes32 nullifier, uint256 candidateId, bytes32 ward)',
  'function addCandidate(string name, string party, string symbolUri, bytes32 ward) returns (uint256)',
  'function setCandidateActive(uint256 candidateId, bool active)',
  'function openVoting(uint64 opensAt_, uint64 closesAt_)',
  'function closeVoting()',
  'function setRelayer(address relayer, bool allowed)',
  'function setPaused(bool paused_)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',

  // --- events ---
  'event VoteCast(bytes32 indexed nullifier, uint256 indexed candidateId, bytes32 indexed ward, uint64 timestamp)',
  'event CandidateAdded(uint256 indexed candidateId, bytes32 indexed ward, string name, string party)',
  'event CandidateActiveSet(uint256 indexed candidateId, bool active)',
  'event VotingOpened(uint64 opensAt, uint64 closesAt)',
  'event VotingClosed(uint64 at, uint256 totalVotes)',
  'event RelayerSet(address indexed relayer, bool allowed)',
  'event PausedSet(bool paused)',
  'event OwnershipTransferStarted(address indexed from, address indexed to)',
  'event OwnershipTransferred(address indexed from, address indexed to)',

  // --- custom errors ---
  'error NotOwner()',
  'error NotPendingOwner()',
  'error NotRelayer()',
  'error ZeroAddress()',
  'error IsPaused()',
  'error WrongPhase(uint8 expected, uint8 actual)',
  'error VotingNotStarted()',
  'error VotingEnded()',
  'error BadWindow()',
  'error EmptyField()',
  'error NoCandidates()',
  'error UnknownCandidate(uint256 candidateId)',
  'error CandidateInactive(uint256 candidateId)',
  'error WardMismatch(bytes32 expected, bytes32 actual)',
  'error AlreadyVoted(bytes32 nullifier)',
  'error ZeroNullifier()',
];

/** Matches the `Phase` enum in the contract. */
const PHASE = Object.freeze({ 0: 'Setup', 1: 'Voting', 2: 'Closed' });

module.exports = { AADHAAR_VOTING_ABI, PHASE };
