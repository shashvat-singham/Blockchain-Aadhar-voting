require('@nomicfoundation/hardhat-toolbox');

/**
 * Deployment key. Only ever read from the environment -- never commit a key.
 * `DEPLOYER_PRIVATE_KEY` is the election authority (contract owner);
 * `RELAYER_PRIVATE_KEY` is the backend that pays gas for voters.
 */
const accounts = [process.env.DEPLOYER_PRIVATE_KEY].filter(Boolean);

/** @type {import('hardhat').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      // Overridable so the same target works from inside a container, where
      // the chain is a sibling service rather than 127.0.0.1.
      url: process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    // Polygon Amoy -- the live testnet that replaced Mumbai.
    amoy: {
      url: process.env.RPC_URL || 'https://rpc-amoy.polygon.technology',
      chainId: 80002,
      accounts,
    },
    sepolia: {
      url: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
      chainId: 11155111,
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      polygonAmoy: process.env.POLYGONSCAN_API_KEY || '',
      sepolia: process.env.ETHERSCAN_API_KEY || '',
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
  },
  paths: {
    sources: './contracts',
    tests: './test',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 60_000,
  },
};
