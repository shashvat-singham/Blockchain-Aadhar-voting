# Aadhaar Voting

A blockchain-recorded voting system that **needs no wallet**. Voters authenticate with
their Aadhaar number and a one-time code sent to their registered mobile — no MetaMask,
no browser extension, no seed phrase, no cryptocurrency, no gas.

Ballots are still written to a public blockchain, and one-vote-per-voter is still enforced
by the smart contract rather than by an application server.

```
Browser (static, no wallet)  →  Vercel serverless API  →  Relayer wallet  →  Smart contract
     Aadhaar + OTP                identity + policy        signs, pays gas     tally + nullifiers
```

---

## Why there is no MetaMask

The previous version asked every voter to install MetaMask, import an account, and hold
funds to pay gas. That is a hard barrier for a public election, and it leaks voter
identity into a wallet address.

This version moves signing to the server. A single **relayer** account — funded and
operated by the election authority — submits every ballot and pays every network fee.
The voter's browser only ever talks to this app's own origin.

Removing the wallet does not weaken the guarantee that matters. The contract stores a
**nullifier** for each voter (`HMAC(secret, aadhaar)`) and rejects a second ballot for
one that is already spent. A compromised or buggy relayer still cannot make anyone vote
twice, and cannot change a recorded tally.

| Concern | Where it is enforced |
|---|---|
| One vote per voter | **Smart contract** (`nullifierUsed` mapping) |
| Voter is on the electoral roll | Backend, against the hashed roll |
| Voter is in the right constituency | **Smart contract** (`WardMismatch`) |
| Polls are open | **Smart contract** (phase + time window) |
| Tally is append-only and public | **Blockchain** |
| Identity verification (OTP) | Backend + SMS provider |

---

## Who pays the gas

The voter never does, in any configuration. Beyond that you have three options,
selected with `GAS_PRICE_WEI`.

| Setup | `GAS_PRICE_WEI` | Real cost | Trade-off |
|---|---|---|---|
| **Zero-fee chain** — private Besu/Geth/Quorum, or the bundled dev chain | `0` | **Nothing, ever** | You run the validators, so the ledger is only as independent as your operators |
| **Public testnet** — Polygon Amoy, Sepolia | unset | Nothing real; faucet tokens are free | Public and verifiable, but testnet tokens are worthless, so it is not suitable for a binding election |
| **Public mainnet** — Polygon | unset | ~₹0.05–0.5 per ballot, paid by the relayer | Strongest independence; the operator carries the cost |

Being straight about it: **"public blockchain" and "literally zero fee" cannot both
be fully true.** Gas is the mechanism a public chain uses to stop spam. What the
zero-fee option gives you is a real, append-only, independently readable ledger with
the fee set to zero — at the price of you operating the validators.

To run genuinely free, point the app at a chain started with a zero minimum gas
price and set `GAS_PRICE_WEI=0`. Ballots are then submitted as legacy transactions
priced at zero: the relayer's balance never moves, so it needs no funding and cannot
run dry mid-election.

```bash
# Geth
geth --miner.gasprice 0 --rpc.txfeecap 0 ...
# Besu
besu --min-gas-price=0 ...
```

`npm run smoke` asserts this rather than assuming it — it reads the relayer balance
before and after a ballot and fails if a zero-fee chain charged anything. Measured on
the bundled chain: **128,659 gas used, total fee 0 wei, balance unchanged.**

`npm run chain` and `docker compose up` are both zero-fee already, so the default
local and demo experience costs nothing.

---

## What is in the box

```
contracts/AadhaarVoting.sol   Ballot contract: roles, phases, nullifiers, ward scoping
test/                          30 contract tests
api/                           Serverless functions (the relayer lives here)
  _lib/                        chain, crypto, sessions, rate limiting, SMS, registry
public/                        Static frontend — no wallet code anywhere in it
server.js                      Standalone server for Docker / VM / local dev
config/election.json           Wards, candidates, party symbols
data/                          Hashed electoral roll
scripts/                       deploy, seed, roll hashing, smoke test
Dockerfile                     runtime + toolchain targets
docker-compose.yml             Chain + contract + app, one command
```

The same `api/` handlers run in all three environments. On Vercel each file becomes
its own function; under Docker or `npm run dev`, `server.js` routes to them using the
identical file-system convention.

### Endpoints

| Route | Purpose |
|---|---|
| `POST /api/auth/request-otp` | Check the roll, text a one-time code |
| `POST /api/auth/verify-otp` | Exchange the code for a short-lived session |
| `GET /api/ballot` | The authenticated voter's constituency ballot |
| `POST /api/vote` | Cast the ballot on-chain (relayer pays gas) |
| `GET /api/results` | Public tallies and turnout |
| `GET /api/config` | Contract address, chain id, ABI — for independent verification |
| `GET /api/health` | Readiness: config, chain, relayer balance, roll |

---

## Run it with Docker

The fastest way to see the whole thing working. One command brings up a blockchain,
deploys and opens the election, hashes the sample roll, and starts the app:

```bash
docker compose up --build
```

Then open <http://localhost:3000> and vote as `300000000000` or `738253790005`. The
one-time code is printed in the `app` service logs and shown in the UI, since the demo
has no SMS gateway.

```bash
docker compose logs -f app     # watch requests and OTP codes
docker compose down -v         # tear down, including the chain state
```

Three services: `chain` (a local Hardhat node), `bootstrap` (deploys, seeds, hashes the
roll, then exits), and `app`. The app waits for `bootstrap` to finish, so the stack is
never half-initialised.

### Building just the app image

The `runtime` target is the deployable image: production dependencies only, no compiler,
no Hardhat, non-root user, `tini` as PID 1 so the graceful shutdown in `server.js` runs.

```bash
docker build --target runtime -t aadhaar-voting .

docker run -p 3000:3000 \
  -e RPC_URL=https://rpc-amoy.polygon.technology \
  -e CHAIN_ID=80002 \
  -e CONTRACT_ADDRESS=0x... \
  -e RELAYER_PRIVATE_KEY=0x... \
  -e SESSION_SECRET=... -e NULLIFIER_SECRET=... -e AADHAAR_PEPPER=... \
  -e OTP_TRANSPORT=twilio -e TWILIO_ACCOUNT_SID=... \
  -v "$PWD/data/voters.json:/run/secrets/voters.json:ro" \
  -e VOTER_REGISTRY_PATH=/run/secrets/voters.json \
  aadhaar-voting
```

The electoral roll is never baked into an image — mount it, or pass
`VOTER_REGISTRY_JSON`. The container's `HEALTHCHECK` uses `/api/health`, which stays
unhealthy until the chain, the relayer and the roll are all usable, so an orchestrator
holds traffic back rather than routing it into failing ballots.

> The compose stack runs with `NODE_ENV=development` on purpose: it has no SMS gateway,
> and the `console` OTP transport is deliberately refused in production so nobody ships
> an election whose codes only exist in a log file. A real deployment uses the image
> default (`NODE_ENV=production`) with `OTP_TRANSPORT=twilio` or `msg91`.

---

## Run it locally

Nothing but Node 20+ is required — no Docker, no Vercel account, no testnet funds.

```bash
npm install
```

**Terminal 1 — a local chain**

```bash
npm run chain
```

**Terminal 2 — configure, deploy, seed**

```bash
cp .env.example .env.local
```

Fill in `.env.local`. For local work you can use Hardhat's well-known test keys
(account #0 as owner, account #1 as relayer) and any 32+ character strings for the three
secrets. Then:

```bash
npm run deploy:local     # prints CONTRACT_ADDRESS — paste it into .env.local
npm run seed:local       # publishes the ballot and opens polling
npm run voters:hash      # turns data/voters.sample.csv into the hashed roll
npm run dev              # http://localhost:3000
```

`npm run dev` runs `server.js` with module reloading, so API edits apply without a
restart. `npm start` runs the same file in production mode. `npm run dev:vercel` uses
`vercel dev` instead, which is the higher-fidelity way to test the Vercel deployment.

With `OTP_TRANSPORT=console` and `DEV_ECHO_OTP=true`, the one-time code is printed to the
server log and shown in the UI, so you can complete the flow without an SMS gateway.

Demo Aadhaar numbers from the sample roll: `300000000000` (Akola), `738253790005`
(Bhandara). `999999999999` is on the roll but marked ineligible, for testing that path.

**Verify the whole flow**

```bash
npm test        # 30 contract tests
npm run smoke   # 33 end-to-end checks against the running stack
```

`npm run smoke` drives the real serverless handlers: identity → OTP → ballot → an actual
on-chain transaction → receipt, and asserts that a second ballot from the same voter is
refused by the contract.

---

## Deploy to Vercel

### 1. Deploy the contract to a public network

Polygon Amoy is the current Polygon testnet (Mumbai was shut down).

```bash
export DEPLOYER_PRIVATE_KEY=0x...    # election authority — the contract owner
export RELAYER_PRIVATE_KEY=0x...     # backend signer — keep this a separate key
export RPC_URL=https://rpc-amoy.polygon.technology

npm run deploy:amoy
npm run seed:amoy
```

Fund the **relayer** address with a small amount of the network's native token. Each
ballot costs roughly 80–120k gas; on Amoy that is a fraction of a cent.

### 2. Import the project

```bash
npm i -g vercel
vercel link
```

`vercel.json` already sets the output directory, function limits, and security headers.
There is no build step — the frontend is static and the API is plain Node.

### 3. Set environment variables

In **Project → Settings → Environment Variables**, from `.env.example`:

| Variable | Notes |
|---|---|
| `RPC_URL` | Server-side RPC. May contain a provider key. |
| `CHAIN_ID` | Checked against the RPC at `/api/health`. |
| `CONTRACT_ADDRESS` | Printed by the deploy script. |
| `RELAYER_PRIVATE_KEY` | **The only key the app needs at runtime.** |
| `GAS_PRICE_WEI` | Set to `0` on a zero-fee chain; leave unset on a public one. |
| `PUBLIC_RPC_URL` | Keyless endpoint handed to the browser for verification. |
| `EXPLORER_TX_URL` | e.g. `https://amoy.polygonscan.com/tx` |
| `SESSION_SECRET` | Encrypts session tokens. |
| `NULLIFIER_SECRET` | Derives on-chain voter ids. **Never rotate mid-election.** |
| `AADHAAR_PEPPER` | Peppers the roll lookup. |
| `OTP_TRANSPORT` | `twilio` or `msg91`. `console` is refused in production. |
| `VOTER_REGISTRY_JSON` | The hashed roll, as one JSON string. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Global rate limits. Strongly recommended. |

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do **not** set `DEPLOYER_PRIVATE_KEY` in Vercel. The owner key is only needed by the
deploy and seed scripts; keeping it off the server means a compromised deployment cannot
close the election, rewrite the ballot, or transfer ownership.

### 4. Ship and check

```bash
vercel deploy --prod
curl https://<your-project>.vercel.app/api/health
```

`/api/health` returns `503` with a list of specific problems until everything is right —
missing variables, wrong chain id, an unauthorised relayer, an unfunded relayer, or a
missing roll.

---

## The electoral roll

The roll is never stored in plaintext. `npm run voters:hash` converts a CSV into digests:

```
aadhaar,ward,phone,eligible
300000000000,AKOLA,+919876543210,true
```

becomes `HMAC(AADHAAR_PEPPER, aadhaar) → { ward, phone, eligible }`.

Aadhaar numbers are only 12 digits, so a plain hash would be exhaustively searchable —
the pepper is what makes the digests useless to anyone who steals the file alone. The
output still contains mobile numbers, so treat it as PII: it is gitignored, and in
production it belongs in `VOTER_REGISTRY_JSON` rather than in the repository.

---

## Running an election

```js
// From the owner account, via Hardhat console or a script:
await voting.addCandidate(name, party, symbolUri, ethers.encodeBytes32String('AKOLA'));
await voting.openVoting(0, closesAtUnixSeconds);  // 0 = open now
await voting.setCandidateActive(candidateId, false);  // handle a withdrawal
await voting.setPaused(true);   // emergency stop; ballots already cast are kept
await voting.closeVoting();     // freeze the tally permanently
```

Candidates are frozen once polling opens. Closing is irreversible.

By default `RESULTS_VISIBILITY=after-close` withholds per-candidate counts until polling
closes, because a visible running total steers voters who have not been yet. Turnout is
always published. Set `RESULTS_VISIBILITY=live` for demos.

---

## Security notes

**What this system provides**

- One ballot per voter, enforced by the contract, not by the backend.
- An append-only public tally that no operator can silently edit.
- Encrypted (JWE) session tokens — a captured token reveals no Aadhaar number.
- Two-step ownership transfer, a relayer kill switch, and an emergency pause.
- Rate limiting on every authentication and voting path.
- Aadhaar numbers never written to the chain, never stored in plaintext.

**What it does not provide, stated plainly**

- **Ballot secrecy against the operator.** `VoteCast` links a nullifier to a candidate.
  Whoever holds `NULLIFIER_SECRET` can correlate a voter to their choice. Real secret
  ballots need a zero-knowledge scheme (e.g. Semaphore); that is out of scope here.
- **Aadhaar verification.** This checks a number against a roll you supply. It does not
  talk to UIDAI, and it is not a substitute for their authentication APIs.
- **Coercion resistance.** A voter can be watched while voting.
- **Relayer trust for liveness.** The relayer cannot forge or double-count votes, but it
  can refuse to submit one. Authorise several relayers to reduce that risk.

**Operational cautions**

- Never rotate `NULLIFIER_SECRET` during an election — it resets every "already voted"
  marker and would let people vote again.
- Keep the owner and relayer keys separate.
- Configure Upstash. Without it, rate limits apply per serverless instance rather than
  globally.
- This is a working reference implementation, not a certified election system. Any real
  public deployment needs an independent security audit and a legal review.

---

## Testing

```bash
npm test               # contract tests
npm run coverage       # coverage report
npm run lint:sol       # solhint
npm run smoke          # end-to-end against a running stack
```

CI runs the contract tests, the linter, an ABI drift check between the contract and
`api/_lib/abi.js`, and a load check on every serverless function.

---

## License

MIT — see [LICENSE](LICENSE).
