'use strict';

const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { ethers } = require('hardhat');
const { AADHAAR_VOTING_ABI } = require('../api/_lib/abi');

/**
 * Deploys AadhaarVoting and prints the exact environment variables to paste
 * into Vercel.
 *
 * The relayer is authorised in the constructor so there is no window where the
 * contract exists but the backend cannot submit ballots.
 */

/**
 * The serverless functions carry a hand-maintained ABI so they never depend on
 * `hardhat compile` having run. That is only safe if the two stay in step, so
 * verify it at deploy time -- the last moment where a mismatch is cheap.
 */
function assertAbiInSync(artifactAbi) {
  // Only function/event/error fragments have a sighash; constructor, fallback
  // and receive do not, and ethers throws rather than returning null for them.
  const SIGNABLE = new Set(['function', 'event', 'error']);
  const signatures = (abi) =>
    new ethers.Interface(abi).fragments.filter((f) => SIGNABLE.has(f.type)).map((f) => f.format('sighash'));

  const compiledSignatures = new Set(signatures(artifactAbi));
  const drift = signatures(AADHAAR_VOTING_ABI).filter((signature) => !compiledSignatures.has(signature));

  if (drift.length > 0) {
    throw new Error(
      `api/_lib/abi.js is out of sync with the compiled contract.\n` +
        `These entries no longer exist on-chain:\n  ${drift.join('\n  ')}`
    );
  }
}

function requireRelayerAddress() {
  if (process.env.RELAYER_ADDRESS) return ethers.getAddress(process.env.RELAYER_ADDRESS);

  if (process.env.RELAYER_PRIVATE_KEY) {
    return new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address;
  }

  throw new Error(
    'Set RELAYER_ADDRESS or RELAYER_PRIVATE_KEY before deploying. ' +
      'The relayer is the backend account that pays gas for voters.'
  );
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'election.json'), 'utf8'));

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const relayerAddress = requireRelayerAddress();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log('Deploying AadhaarVoting');
  console.log(`  network   ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`  deployer  ${deployer.address}  [${ethers.formatEther(balance)} ETH]`);
  console.log(`  relayer   ${relayerAddress}`);
  console.log(`  election  ${config.name}`);

  if (balance === 0n) {
    throw new Error('Deployer account has no funds. Top it up before deploying.');
  }
  if (relayerAddress === deployer.address) {
    console.warn(
      '\n  ! Relayer and owner are the same account. Use separate keys in production so a\n' +
        '    leaked relayer key cannot also close the election or edit the ballot.\n'
    );
  }

  const artifact = await hre.artifacts.readArtifact('AadhaarVoting');
  assertAbiInSync(artifact.abi);

  const factory = await ethers.getContractFactory('AadhaarVoting');
  const contract = await factory.deploy(config.name, relayerAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  await deployTx.wait(hre.network.name === 'hardhat' || hre.network.name === 'localhost' ? 1 : 2);

  console.log(`\nDeployed to ${address}`);
  console.log(`  tx ${deployTx.hash}`);

  // Record the deployment so seed/verify steps and CI can find the address.
  const outputDir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(outputDir, { recursive: true });

  const record = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    address,
    owner: deployer.address,
    relayer: relayerAddress,
    electionName: config.name,
    txHash: deployTx.hash,
    blockNumber: deployTx.blockNumber,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputDir, `${hre.network.name}.json`), `${JSON.stringify(record, null, 2)}\n`);

  console.log('\nSet these in your Vercel project (and .env.local for `vercel dev`):');
  console.log(`  CONTRACT_ADDRESS=${address}`);
  console.log(`  CHAIN_ID=${network.chainId}`);
  console.log('\nNext: `npm run seed:<network>` to publish the ballot and open polling.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
