'use strict';

const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { ethers } = require('hardhat');

/**
 * Publishes the ballot from config/election.json and opens polling.
 *
 * Safe to re-run: candidates already on-chain are skipped, and an election
 * that has already moved past Setup is left alone rather than half-modified.
 */

function resolveAddress() {
  if (process.env.CONTRACT_ADDRESS) return ethers.getAddress(process.env.CONTRACT_ADDRESS);

  const file = path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).address;

  throw new Error(`Set CONTRACT_ADDRESS, or deploy first so deployments/${hre.network.name}.json exists.`);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'election.json'), 'utf8'));
  const address = resolveAddress();

  const [signer] = await ethers.getSigners();
  const contract = await ethers.getContractAt('AadhaarVoting', address, signer);

  const owner = await contract.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only the owner (${owner}) can seed the ballot; you are ${signer.address}.`);
  }

  const phase = Number(await contract.phase());
  console.log(`Seeding ${address} on ${hre.network.name} (phase: ${['Setup', 'Voting', 'Closed'][phase]})`);

  if (phase !== 0) {
    console.log('\nElection has already left Setup. Candidates are frozen; nothing to do.');
    return;
  }

  // Skip anything already published, so a re-run after a failed tx resumes.
  const existing = await contract.getCandidates();
  const published = new Set(existing.map((c) => `${ethers.decodeBytes32String(c.ward)}|${c.name}`));

  let added = 0;
  for (const candidate of config.candidates) {
    const key = `${candidate.ward}|${candidate.name}`;
    if (published.has(key)) {
      console.log(`  = ${key} (already published)`);
      continue;
    }

    const tx = await contract.addCandidate(
      candidate.name,
      candidate.party,
      candidate.symbolUri || '',
      ethers.encodeBytes32String(candidate.ward)
    );
    await tx.wait();
    console.log(`  + ${key}`);
    added += 1;
  }

  if (added === 0 && existing.length === 0) {
    throw new Error('config/election.json lists no candidates; nothing to open polling with.');
  }

  const window = config.pollingWindow || {};
  const opensAt = Number(window.opensAt) || 0; // 0 means "now", per the contract
  const durationHours = Number(window.durationHours) || 168;
  const effectiveStart = opensAt || Math.floor(Date.now() / 1000);
  const closesAt = effectiveStart + Math.round(durationHours * 3600);

  const openTx = await contract.openVoting(opensAt, closesAt);
  await openTx.wait();

  console.log(`\nPolling is open until ${new Date(closesAt * 1000).toISOString()}`);
  console.log(`  candidates ${(await contract.candidateCount()).toString()}`);
  console.log('  close it with: contract.closeVoting() from the owner account');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
