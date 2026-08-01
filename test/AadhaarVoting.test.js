'use strict';

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const AKOLA = ethers.encodeBytes32String('AKOLA');
const BHANDARA = ethers.encodeBytes32String('BHANDARA');

const PHASE = { SETUP: 0, VOTING: 1, CLOSED: 2 };
const HOUR = 3600;

/** Stand-in for HMAC(NULLIFIER_SECRET, aadhaar); only uniqueness matters here. */
const nullifier = (label) => ethers.keccak256(ethers.toUtf8Bytes(`voter:${label}`));

describe('AadhaarVoting', () => {
  async function deployFixture() {
    const [owner, relayer, otherRelayer, outsider] = await ethers.getSigners();
    const factory = await ethers.getContractFactory('AadhaarVoting');
    const voting = await factory.deploy('General Election 2026', relayer.address);
    return { voting, owner, relayer, otherRelayer, outsider };
  }

  /** Ballot published, polls open for a week. */
  async function openElectionFixture() {
    const context = await loadFixture(deployFixture);
    const { voting } = context;

    await voting.addCandidate('Sanat Taori', 'BJP', '/images/bjp.png', AKOLA);
    await voting.addCandidate('Aniket Narkhede', 'INC', '/images/cong.png', AKOLA);
    await voting.addCandidate('Priya Deshmukh', 'BJP', '/images/bjp.png', BHANDARA);

    const now = await time.latest();
    const closesAt = now + 7 * 24 * HOUR;
    await voting.openVoting(0, closesAt);

    return { ...context, closesAt };
  }

  describe('deployment', () => {
    it('records the owner, election name and initial relayer', async () => {
      const { voting, owner, relayer } = await loadFixture(deployFixture);

      expect(await voting.owner()).to.equal(owner.address);
      expect(await voting.electionName()).to.equal('General Election 2026');
      expect(await voting.phase()).to.equal(PHASE.SETUP);
      expect(await voting.isRelayer(relayer.address)).to.equal(true);
      expect(await voting.paused()).to.equal(false);
    });

    it('rejects an empty election name', async () => {
      const factory = await ethers.getContractFactory('AadhaarVoting');
      await expect(factory.deploy('', ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, 'EmptyField');
    });

    it('allows deployment with no relayer, to be set later', async () => {
      const [, relayer] = await ethers.getSigners();
      const factory = await ethers.getContractFactory('AadhaarVoting');
      const voting = await factory.deploy('Test', ethers.ZeroAddress);

      expect(await voting.isRelayer(relayer.address)).to.equal(false);
      await voting.setRelayer(relayer.address, true);
      expect(await voting.isRelayer(relayer.address)).to.equal(true);
    });
  });

  describe('access control', () => {
    it('only the owner may add candidates', async () => {
      const { voting, outsider } = await loadFixture(deployFixture);

      await expect(
        voting.connect(outsider).addCandidate('Mallory', 'IND', '', AKOLA)
      ).to.be.revertedWithCustomError(voting, 'NotOwner');
    });

    it('only the owner may open or close voting', async () => {
      const { voting, outsider } = await loadFixture(openElectionFixture);

      await expect(voting.connect(outsider).closeVoting()).to.be.revertedWithCustomError(voting, 'NotOwner');
    });

    it('only a relayer may cast a ballot', async () => {
      const { voting, owner, outsider } = await loadFixture(openElectionFixture);

      // Even the owner cannot vote unless explicitly authorised as a relayer.
      await expect(voting.connect(owner).castVote(nullifier('a'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'NotRelayer'
      );
      await expect(voting.connect(outsider).castVote(nullifier('a'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'NotRelayer'
      );
    });

    it('revoking a relayer stops it immediately -- the leaked-key kill switch', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);
      await voting.setRelayer(relayer.address, false);

      await expect(voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'NotRelayer'
      );
    });

    it('supports multiple relayers for horizontal scale', async () => {
      const { voting, relayer, otherRelayer } = await loadFixture(openElectionFixture);

      await voting.setRelayer(otherRelayer.address, true);
      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);
      await voting.connect(otherRelayer).castVote(nullifier('b'), 0, AKOLA);

      expect((await voting.getCandidate(0)).voteCount).to.equal(2n);
    });

    it('transfers ownership only in two steps', async () => {
      const { voting, owner, outsider } = await loadFixture(deployFixture);

      await voting.transferOwnership(outsider.address);
      expect(await voting.owner()).to.equal(owner.address); // not yet

      await expect(voting.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
        voting,
        'NotPendingOwner'
      );

      await voting.connect(outsider).acceptOwnership();
      expect(await voting.owner()).to.equal(outsider.address);
      expect(await voting.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe('ballot definition', () => {
    it('assigns sequential ids and emits CandidateAdded', async () => {
      const { voting } = await loadFixture(deployFixture);

      await expect(voting.addCandidate('Sanat Taori', 'BJP', '/images/bjp.png', AKOLA))
        .to.emit(voting, 'CandidateAdded')
        .withArgs(0, AKOLA, 'Sanat Taori', 'BJP');

      await expect(voting.addCandidate('Aniket Narkhede', 'INC', '', AKOLA))
        .to.emit(voting, 'CandidateAdded')
        .withArgs(1, AKOLA, 'Aniket Narkhede', 'INC');

      expect(await voting.candidateCount()).to.equal(2n);
    });

    it('rejects empty names, parties and wards', async () => {
      const { voting } = await loadFixture(deployFixture);

      await expect(voting.addCandidate('', 'BJP', '', AKOLA)).to.be.revertedWithCustomError(voting, 'EmptyField');
      await expect(voting.addCandidate('Sanat', '', '', AKOLA)).to.be.revertedWithCustomError(voting, 'EmptyField');
      await expect(
        voting.addCandidate('Sanat', 'BJP', '', ethers.ZeroHash)
      ).to.be.revertedWithCustomError(voting, 'EmptyField');
    });

    it('freezes the candidate list once voting opens', async () => {
      const { voting } = await loadFixture(openElectionFixture);

      await expect(voting.addCandidate('Late Entry', 'IND', '', AKOLA))
        .to.be.revertedWithCustomError(voting, 'WrongPhase')
        .withArgs(PHASE.SETUP, PHASE.VOTING);
    });

    it('filters candidates by ward', async () => {
      const { voting } = await loadFixture(openElectionFixture);

      const [akolaIds, akola] = await voting.getCandidatesByWard(AKOLA);
      expect(akolaIds.map(Number)).to.deep.equal([0, 1]);
      expect(akola.map((c) => c.name)).to.deep.equal(['Sanat Taori', 'Aniket Narkhede']);

      const [bhandaraIds, bhandara] = await voting.getCandidatesByWard(BHANDARA);
      expect(bhandaraIds.map(Number)).to.deep.equal([2]);
      expect(bhandara[0].name).to.equal('Priya Deshmukh');

      const [emptyIds] = await voting.getCandidatesByWard(ethers.encodeBytes32String('NOWHERE'));
      expect(emptyIds.length).to.equal(0);
    });
  });

  describe('election lifecycle', () => {
    it('will not open with no candidates', async () => {
      const { voting } = await loadFixture(deployFixture);
      const now = await time.latest();

      await expect(voting.openVoting(0, now + HOUR)).to.be.revertedWithCustomError(voting, 'NoCandidates');
    });

    it('rejects a closing time at or before the opening time', async () => {
      const { voting } = await loadFixture(deployFixture);
      await voting.addCandidate('Sanat Taori', 'BJP', '', AKOLA);

      const now = await time.latest();
      await expect(voting.openVoting(now + HOUR, now + HOUR)).to.be.revertedWithCustomError(voting, 'BadWindow');
      await expect(voting.openVoting(now + 2 * HOUR, now + HOUR)).to.be.revertedWithCustomError(
        voting,
        'BadWindow'
      );
    });

    it('treats opensAt = 0 as "now"', async () => {
      const { voting } = await loadFixture(deployFixture);
      await voting.addCandidate('Sanat Taori', 'BJP', '', AKOLA);

      const closesAt = (await time.latest()) + HOUR;
      await voting.openVoting(0, closesAt);

      expect(await voting.opensAt()).to.be.closeTo(await time.latest(), 5);
      expect(await voting.isVotingLive()).to.equal(true);
    });

    it('refuses ballots before the window opens and after it ends', async () => {
      const { voting, relayer } = await loadFixture(deployFixture);
      await voting.addCandidate('Sanat Taori', 'BJP', '', AKOLA);

      const now = await time.latest();
      await voting.openVoting(now + HOUR, now + 2 * HOUR);

      await expect(voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'VotingNotStarted'
      );

      await time.increaseTo(now + HOUR + 60);
      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);

      await time.increaseTo(now + 2 * HOUR + 60);
      await expect(voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'VotingEnded'
      );
    });

    it('freezes tallies permanently once closed', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);
      await expect(voting.closeVoting()).to.emit(voting, 'VotingClosed');

      expect(await voting.phase()).to.equal(PHASE.CLOSED);
      await expect(voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA))
        .to.be.revertedWithCustomError(voting, 'WrongPhase')
        .withArgs(PHASE.VOTING, PHASE.CLOSED);

      // Closing is not reversible.
      await expect(voting.openVoting(0, (await time.latest()) + HOUR)).to.be.revertedWithCustomError(
        voting,
        'WrongPhase'
      );
      await expect(voting.closeVoting()).to.be.revertedWithCustomError(voting, 'WrongPhase');
    });

    it('pauses and resumes voting without losing recorded ballots', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);

      await expect(voting.setPaused(true)).to.emit(voting, 'PausedSet').withArgs(true);
      expect(await voting.isVotingLive()).to.equal(false);
      await expect(voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'IsPaused'
      );

      await voting.setPaused(false);
      await voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA);
      expect(await voting.totalVotes()).to.equal(2n);
    });
  });

  describe('casting ballots', () => {
    it('records a vote, the turnout and an auditable event', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);
      const voter = nullifier('a');

      await expect(voting.connect(relayer).castVote(voter, 1, AKOLA)).to.emit(voting, 'VoteCast');

      expect((await voting.getCandidate(1)).voteCount).to.equal(1n);
      expect((await voting.getCandidate(0)).voteCount).to.equal(0n);
      expect(await voting.totalVotes()).to.equal(1n);
      expect(await voting.wardTurnout(AKOLA)).to.equal(1n);
      expect(await voting.nullifierUsed(voter)).to.equal(true);
    });

    it('enforces one ballot per voter on-chain, not in the backend', async () => {
      const { voting, relayer, otherRelayer } = await loadFixture(openElectionFixture);
      const voter = nullifier('a');

      await voting.connect(relayer).castVote(voter, 0, AKOLA);

      await expect(voting.connect(relayer).castVote(voter, 0, AKOLA))
        .to.be.revertedWithCustomError(voting, 'AlreadyVoted')
        .withArgs(voter);

      // A different candidate does not create a second chance.
      await expect(voting.connect(relayer).castVote(voter, 1, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'AlreadyVoted'
      );

      // Nor does a second, compromised relayer.
      await voting.setRelayer(otherRelayer.address, true);
      await expect(voting.connect(otherRelayer).castVote(voter, 0, AKOLA)).to.be.revertedWithCustomError(
        voting,
        'AlreadyVoted'
      );

      expect(await voting.totalVotes()).to.equal(1n);
    });

    it('keeps a voter inside their own constituency', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      // Candidate 2 contests Bhandara; this voter is registered in Akola.
      await expect(voting.connect(relayer).castVote(nullifier('a'), 2, AKOLA))
        .to.be.revertedWithCustomError(voting, 'WardMismatch')
        .withArgs(BHANDARA, AKOLA);

      // The rejected attempt must not have consumed the voter.
      expect(await voting.nullifierUsed(nullifier('a'))).to.equal(false);
      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);
      expect(await voting.totalVotes()).to.equal(1n);
    });

    it('rejects an unknown candidate id', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await expect(voting.connect(relayer).castVote(nullifier('a'), 99, AKOLA))
        .to.be.revertedWithCustomError(voting, 'UnknownCandidate')
        .withArgs(99);
    });

    it('rejects a zero nullifier, which would let one slot absorb every voter', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await expect(
        voting.connect(relayer).castVote(ethers.ZeroHash, 0, AKOLA)
      ).to.be.revertedWithCustomError(voting, 'ZeroNullifier');
    });

    it('rejects a withdrawn candidate but keeps their existing votes', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);
      await expect(voting.setCandidateActive(0, false))
        .to.emit(voting, 'CandidateActiveSet')
        .withArgs(0, false);

      await expect(voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA))
        .to.be.revertedWithCustomError(voting, 'CandidateInactive')
        .withArgs(0);

      expect((await voting.getCandidate(0)).voteCount).to.equal(1n);

      // Reinstating restores voting for that candidate.
      await voting.setCandidateActive(0, true);
      await voting.connect(relayer).castVote(nullifier('b'), 0, AKOLA);
      expect((await voting.getCandidate(0)).voteCount).to.equal(2n);
    });

    it('tallies many voters across wards correctly', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      for (let i = 0; i < 12; i += 1) {
        await voting.connect(relayer).castVote(nullifier(`akola-${i}`), i % 2, AKOLA);
      }
      for (let i = 0; i < 5; i += 1) {
        await voting.connect(relayer).castVote(nullifier(`bhandara-${i}`), 2, BHANDARA);
      }

      expect((await voting.getCandidate(0)).voteCount).to.equal(6n);
      expect((await voting.getCandidate(1)).voteCount).to.equal(6n);
      expect((await voting.getCandidate(2)).voteCount).to.equal(5n);
      expect(await voting.totalVotes()).to.equal(17n);
      expect(await voting.wardTurnout(AKOLA)).to.equal(12n);
      expect(await voting.wardTurnout(BHANDARA)).to.equal(5n);
    });

    it('counts past 255, unlike the uint8 tally it replaces', async () => {
      const { voting, relayer } = await loadFixture(openElectionFixture);

      // The original contract stored votes in a uint8 and silently wrapped at
      // 256. Cover the old boundary explicitly.
      for (let i = 0; i < 260; i += 1) {
        await voting.connect(relayer).castVote(nullifier(`bulk-${i}`), 0, AKOLA);
      }

      expect((await voting.getCandidate(0)).voteCount).to.equal(260n);
      expect(await voting.totalVotes()).to.equal(260n);
    });
  });

  describe('views', () => {
    it('reports a single-call election status', async () => {
      const { voting, relayer, closesAt } = await loadFixture(openElectionFixture);
      await voting.connect(relayer).castVote(nullifier('a'), 0, AKOLA);

      const status = await voting.electionStatus();
      expect(status.name_).to.equal('General Election 2026');
      expect(status.phase_).to.equal(PHASE.VOTING);
      expect(status.closesAt_).to.equal(BigInt(closesAt));
      expect(status.totalVotes_).to.equal(1n);
      expect(status.candidateCount_).to.equal(3n);
      expect(status.paused_).to.equal(false);
    });

    it('reverts on an out-of-range candidate lookup', async () => {
      const { voting } = await loadFixture(openElectionFixture);

      await expect(voting.getCandidate(99)).to.be.revertedWithCustomError(voting, 'UnknownCandidate');
    });

    it('isVotingLive tracks phase, pause state and the clock together', async () => {
      const { voting } = await loadFixture(deployFixture);
      await voting.addCandidate('Sanat Taori', 'BJP', '', AKOLA);
      expect(await voting.isVotingLive()).to.equal(false); // still in Setup

      const now = await time.latest();
      await voting.openVoting(now + HOUR, now + 2 * HOUR);
      expect(await voting.isVotingLive()).to.equal(false); // not started

      await time.increaseTo(now + HOUR + 60);
      expect(await voting.isVotingLive()).to.equal(true);

      await time.increaseTo(now + 2 * HOUR + 60);
      expect(await voting.isVotingLive()).to.equal(false); // window elapsed
    });
  });
});
