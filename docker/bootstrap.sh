#!/usr/bin/env bash
#
# One-shot setup for the local docker-compose stack:
#
#   1. wait for the chain
#   2. deploy the contract
#   3. publish the ballot and open polling
#   4. hash the sample electoral roll
#   5. write /state/contract.env for the app service
#
# Idempotent: re-running against an already-deployed chain reuses the existing
# contract instead of deploying a second one.

set -euo pipefail

STATE_DIR="${STATE_DIR:-/state}"
CHAIN_URL="${LOCALHOST_RPC_URL:-http://chain:8545}"
CONTRACT_ENV="${STATE_DIR}/contract.env"
VOTERS_FILE="${STATE_DIR}/voters.json"

mkdir -p "${STATE_DIR}"

log() { printf '\n[bootstrap] %s\n' "$*"; }

# --- 1. wait for the chain ---------------------------------------------------
log "Waiting for the chain at ${CHAIN_URL}"
for attempt in $(seq 1 60); do
  if curl -fsS -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "${CHAIN_URL}" >/dev/null 2>&1; then
    log "Chain is up (after ${attempt}s)"
    break
  fi
  if [ "${attempt}" -eq 60 ]; then
    log "Chain did not become ready in 60s. Is the 'chain' service running?"
    exit 1
  fi
  sleep 1
done

# --- 2 & 3. deploy and seed --------------------------------------------------
# A fresh `hardhat node` starts from an empty state, so a leftover deployment
# record from a previous run would point at an address with no code.
if [ -f "${CONTRACT_ENV}" ]; then
  # shellcheck disable=SC1090
  . "${CONTRACT_ENV}"
  CODE=$(curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"${CONTRACT_ADDRESS}\",\"latest\"],\"id\":1}" \
    "${CHAIN_URL}" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

  if [ "${CODE}" != "0x" ] && [ -n "${CODE}" ]; then
    log "Contract already deployed at ${CONTRACT_ADDRESS}; skipping deploy."
    SKIP_DEPLOY=1
  else
    log "Recorded contract has no code on this chain; redeploying."
    rm -f "${CONTRACT_ENV}"
  fi
fi

if [ -z "${SKIP_DEPLOY:-}" ]; then
  log "Deploying the contract"
  npx hardhat run scripts/deploy.js --network localhost

  ADDRESS=$(node -e "console.log(require('./deployments/localhost.json').address)")
  printf 'CONTRACT_ADDRESS=%s\nCHAIN_ID=31337\n' "${ADDRESS}" > "${CONTRACT_ENV}"
  log "Contract at ${ADDRESS}"

  log "Publishing the ballot and opening polling"
  CONTRACT_ADDRESS="${ADDRESS}" npx hardhat run scripts/seed.js --network localhost
fi

# --- 4. electoral roll -------------------------------------------------------
if [ -f "${VOTERS_FILE}" ]; then
  log "Electoral roll already present at ${VOTERS_FILE}"
else
  log "Hashing the sample electoral roll"
  node scripts/hash-voters.js data/voters.sample.csv "${VOTERS_FILE}"
fi

log "Ready. The app can start."
