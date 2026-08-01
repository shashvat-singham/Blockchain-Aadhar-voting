// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title AadhaarVoting
 * @notice Ward-scoped ballot with on-chain, one-vote-per-voter enforcement.
 *
 * @dev Design notes
 *
 * 1. NO VOTER WALLET. Voters never hold keys, never sign, never pay gas. An
 *    authorised relayer (the application backend) submits ballots on their
 *    behalf after off-chain identity verification. `msg.sender` therefore
 *    carries no voter identity and is only used for authorisation.
 *
 * 2. NULLIFIERS. A voter is represented on-chain only by a `nullifier`:
 *    keccak256(serverSecret, aadhaarNumber). The Aadhaar number is never
 *    written to chain and cannot be recovered from the nullifier without the
 *    server secret, while the mapping stays deterministic so the contract can
 *    reject a second ballot from the same person. Double-voting is prevented
 *    by the chain, not by the backend -- a compromised or buggy relayer still
 *    cannot vote twice for one voter.
 *
 * 3. PRIVACY LIMIT, STATED PLAINLY. `VoteCast` links a nullifier to a
 *    candidate in the same transaction. Ballots are pseudonymous, not
 *    anonymous: whoever holds the server secret can correlate a voter to their
 *    choice. Unlinkable secret ballots require a zero-knowledge scheme
 *    (e.g. Semaphore) and are out of scope for this contract.
 */
contract AadhaarVoting {
    /* --------------------------------------------------------------------- */
    /*                                  Types                                 */
    /* --------------------------------------------------------------------- */

    enum Phase {
        Setup, // candidates may be added/edited; no voting
        Voting, // ballot is live within [opensAt, closesAt]
        Closed // final; tallies frozen forever
    }

    struct Candidate {
        string name;
        string party;
        string symbolUri; // static path or ipfs:// CID for the party symbol
        bytes32 ward; // constituency this candidate contests
        bool active;
        uint256 voteCount;
    }

    /* --------------------------------------------------------------------- */
    /*                                 Storage                                */
    /* --------------------------------------------------------------------- */

    string public electionName;
    Phase public phase;

    address public owner;
    address public pendingOwner;
    bool public paused;

    uint64 public opensAt;
    uint64 public closesAt;

    /// @notice Backends authorised to submit ballots.
    mapping(address => bool) public isRelayer;

    /// @notice keccak256(serverSecret, aadhaar) => already voted.
    mapping(bytes32 => bool) public nullifierUsed;

    Candidate[] private _candidates;

    uint256 public totalVotes;
    /// @notice Ballots cast per ward, for turnout reporting.
    mapping(bytes32 => uint256) public wardTurnout;

    /* --------------------------------------------------------------------- */
    /*                                 Events                                 */
    /* --------------------------------------------------------------------- */

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event RelayerSet(address indexed relayer, bool allowed);
    event PausedSet(bool paused);

    event CandidateAdded(uint256 indexed candidateId, bytes32 indexed ward, string name, string party);
    event CandidateActiveSet(uint256 indexed candidateId, bool active);

    event VotingOpened(uint64 opensAt, uint64 closesAt);
    event VotingClosed(uint64 at, uint256 totalVotes);

    event VoteCast(bytes32 indexed nullifier, uint256 indexed candidateId, bytes32 indexed ward, uint64 timestamp);

    /* --------------------------------------------------------------------- */
    /*                                 Errors                                 */
    /* --------------------------------------------------------------------- */

    error NotOwner();
    error NotPendingOwner();
    error NotRelayer();
    error ZeroAddress();
    error IsPaused();
    error WrongPhase(Phase expected, Phase actual);
    error VotingNotStarted();
    error VotingEnded();
    error BadWindow();
    error EmptyField();
    error NoCandidates();
    error UnknownCandidate(uint256 candidateId);
    error CandidateInactive(uint256 candidateId);
    error WardMismatch(bytes32 expected, bytes32 actual);
    error AlreadyVoted(bytes32 nullifier);
    error ZeroNullifier();

    /* --------------------------------------------------------------------- */
    /*                               Modifiers                                */
    /* --------------------------------------------------------------------- */

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        _;
    }

    modifier atPhase(Phase expected) {
        if (phase != expected) revert WrongPhase(expected, phase);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    /* --------------------------------------------------------------------- */
    /*                              Construction                              */
    /* --------------------------------------------------------------------- */

    /**
     * @param name_ Human-readable election name, e.g. "Lok Sabha 2026".
     * @param initialRelayer Backend address that will submit ballots. May be
     *        the zero address if relayers are configured later.
     */
    constructor(string memory name_, address initialRelayer) {
        if (bytes(name_).length == 0) revert EmptyField();

        owner = msg.sender;
        electionName = name_;
        phase = Phase.Setup;

        emit OwnershipTransferred(address(0), msg.sender);

        if (initialRelayer != address(0)) {
            isRelayer[initialRelayer] = true;
            emit RelayerSet(initialRelayer, true);
        }
    }

    /* --------------------------------------------------------------------- */
    /*                             Administration                             */
    /* --------------------------------------------------------------------- */

    /// @notice Step 1 of two-step ownership transfer. Guards against typos.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of two-step ownership transfer, called by the new owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @notice Authorise or revoke a backend relayer. Revoking is the kill
    ///         switch for a leaked relayer key.
    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    /// @notice Emergency stop for `castVote`. Admin reads stay available.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /* --------------------------------------------------------------------- */
    /*                            Ballot definition                           */
    /* --------------------------------------------------------------------- */

    function addCandidate(
        string calldata name,
        string calldata party,
        string calldata symbolUri,
        bytes32 ward
    ) external onlyOwner atPhase(Phase.Setup) returns (uint256 candidateId) {
        if (bytes(name).length == 0 || bytes(party).length == 0) revert EmptyField();
        if (ward == bytes32(0)) revert EmptyField();

        candidateId = _candidates.length;
        _candidates.push(
            Candidate({name: name, party: party, symbolUri: symbolUri, ward: ward, active: true, voteCount: 0})
        );

        emit CandidateAdded(candidateId, ward, name, party);
    }

    /// @notice Withdraw or reinstate a candidate. Allowed mid-election so a
    ///         disqualification does not require voiding the whole ballot.
    ///         Votes already cast are retained.
    function setCandidateActive(uint256 candidateId, bool active) external onlyOwner {
        if (phase == Phase.Closed) revert WrongPhase(Phase.Voting, phase);
        if (candidateId >= _candidates.length) revert UnknownCandidate(candidateId);
        _candidates[candidateId].active = active;
        emit CandidateActiveSet(candidateId, active);
    }

    /* --------------------------------------------------------------------- */
    /*                            Election lifecycle                          */
    /* --------------------------------------------------------------------- */

    /**
     * @notice Move Setup -> Voting and fix the polling window. Candidates are
     *         frozen from this point (only activation can change).
     * @param opensAt_ Unix seconds when polls open. Pass 0 for "now".
     * @param closesAt_ Unix seconds when polls close. Must be after `opensAt_`.
     */
    function openVoting(uint64 opensAt_, uint64 closesAt_) external onlyOwner atPhase(Phase.Setup) {
        if (_candidates.length == 0) revert NoCandidates();

        uint64 start = opensAt_ == 0 ? uint64(block.timestamp) : opensAt_;
        if (closesAt_ <= start) revert BadWindow();

        opensAt = start;
        closesAt = closesAt_;
        phase = Phase.Voting;

        emit VotingOpened(start, closesAt_);
    }

    /// @notice Freeze the tally permanently. Idempotent guard via phase check.
    function closeVoting() external onlyOwner atPhase(Phase.Voting) {
        phase = Phase.Closed;
        closesAt = uint64(block.timestamp);
        emit VotingClosed(uint64(block.timestamp), totalVotes);
    }

    /* --------------------------------------------------------------------- */
    /*                                 Voting                                 */
    /* --------------------------------------------------------------------- */

    /**
     * @notice Record one ballot. Called by the relayer, which pays gas.
     * @param nullifier keccak256(serverSecret, aadhaar). Must be unused.
     * @param candidateId Index into the candidate list.
     * @param ward The voter's constituency, asserted against the candidate's.
     *
     * @dev The relayer is trusted to have verified identity and derived the
     *      correct ward. It is NOT trusted for uniqueness -- that is enforced
     *      here, so a relayer bug or compromise cannot inflate the tally for a
     *      voter who has already voted.
     */
    function castVote(
        bytes32 nullifier,
        uint256 candidateId,
        bytes32 ward
    ) external onlyRelayer whenNotPaused atPhase(Phase.Voting) {
        if (nullifier == bytes32(0)) revert ZeroNullifier();
        if (block.timestamp < opensAt) revert VotingNotStarted();
        if (block.timestamp > closesAt) revert VotingEnded();
        if (candidateId >= _candidates.length) revert UnknownCandidate(candidateId);

        // Checks-effects: mark the voter spent before touching the tally.
        if (nullifierUsed[nullifier]) revert AlreadyVoted(nullifier);

        Candidate storage candidate = _candidates[candidateId];
        if (!candidate.active) revert CandidateInactive(candidateId);
        if (candidate.ward != ward) revert WardMismatch(candidate.ward, ward);

        nullifierUsed[nullifier] = true;
        unchecked {
            // Bounded by the number of distinct nullifiers; cannot overflow.
            candidate.voteCount += 1;
            totalVotes += 1;
            wardTurnout[ward] += 1;
        }

        emit VoteCast(nullifier, candidateId, ward, uint64(block.timestamp));
    }

    /* --------------------------------------------------------------------- */
    /*                                  Views                                 */
    /* --------------------------------------------------------------------- */

    function candidateCount() external view returns (uint256) {
        return _candidates.length;
    }

    function getCandidate(uint256 candidateId) external view returns (Candidate memory) {
        if (candidateId >= _candidates.length) revert UnknownCandidate(candidateId);
        return _candidates[candidateId];
    }

    /// @notice Full ballot. Candidate count is in the low hundreds at most, so
    ///         returning the array is cheaper than paging for callers.
    function getCandidates() external view returns (Candidate[] memory) {
        return _candidates;
    }

    /// @notice Candidates contesting a single ward, with their live tallies.
    function getCandidatesByWard(
        bytes32 ward
    ) external view returns (uint256[] memory ids, Candidate[] memory list) {
        uint256 total = _candidates.length;

        uint256 matched;
        for (uint256 i; i < total; ++i) {
            if (_candidates[i].ward == ward) ++matched;
        }

        ids = new uint256[](matched);
        list = new Candidate[](matched);

        uint256 cursor;
        for (uint256 i; i < total; ++i) {
            if (_candidates[i].ward != ward) continue;
            ids[cursor] = i;
            list[cursor] = _candidates[i];
            ++cursor;
        }
    }

    /// @notice True while ballots are actually accepted right now.
    function isVotingLive() external view returns (bool) {
        return phase == Phase.Voting && !paused && block.timestamp >= opensAt && block.timestamp <= closesAt;
    }

    /// @notice Single-call snapshot for the results page.
    function electionStatus()
        external
        view
        returns (
            string memory name_,
            Phase phase_,
            uint64 opensAt_,
            uint64 closesAt_,
            uint256 totalVotes_,
            uint256 candidateCount_,
            bool paused_
        )
    {
        return (electionName, phase, opensAt, closesAt, totalVotes, _candidates.length, paused);
    }
}
