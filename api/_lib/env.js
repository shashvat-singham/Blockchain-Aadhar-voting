'use strict';

/**
 * Centralised environment access.
 *
 * Nothing here throws at module load: on a serverless platform a throwing
 * import turns every route into an opaque 500. Instead configuration problems
 * are collected and surfaced through `configReport()` (see /api/health) and
 * raised as typed errors at the point of use.
 */

const MIN_SECRET_LENGTH = 32;

function str(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value.trim();
}

function int(name, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback = false) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProduction: str('VERCEL_ENV', str('NODE_ENV', 'development')) === 'production',

  // ---- Chain ----------------------------------------------------------
  rpcUrl: str('RPC_URL'),
  chainId: int('CHAIN_ID', 0),
  contractAddress: str('CONTRACT_ADDRESS'),
  relayerPrivateKey: str('RELAYER_PRIVATE_KEY'),
  /** RPC handed to the browser so anyone can verify tallies without a wallet. */
  publicRpcUrl: str('PUBLIC_RPC_URL'),
  explorerTxUrl: str('EXPLORER_TX_URL'),
  /** Confirmations to wait for before reporting a vote as final. */
  confirmations: int('TX_CONFIRMATIONS', 1),
  txTimeoutMs: int('TX_TIMEOUT_MS', 60_000),
  /** Warn when the relayer can no longer reliably pay for ballots. */
  relayerMinBalanceWei: str('RELAYER_MIN_BALANCE_WEI', '10000000000000000'), // 0.01
  /**
   * Explicit gas price in wei. Set to "0" on a zero-fee chain (a private
   * Besu/Geth network, or the bundled dev chain) so ballots cost nothing at
   * all -- neither the voter nor the operator pays. Leave unset on a public
   * network to let the node quote the market rate.
   */
  gasPriceWei: str('GAS_PRICE_WEI'),

  // ---- Secrets --------------------------------------------------------
  sessionSecret: str('SESSION_SECRET'),
  nullifierSecret: str('NULLIFIER_SECRET'),
  aadhaarPepper: str('AADHAAR_PEPPER'),
  adminApiKey: str('ADMIN_API_KEY'),

  // ---- Auth policy ----------------------------------------------------
  otpTtlSeconds: int('OTP_TTL_SECONDS', 300),
  otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 900),
  otpLength: int('OTP_LENGTH', 6),

  // ---- OTP delivery ---------------------------------------------------
  otpTransport: (str('OTP_TRANSPORT', 'console') || 'console').toLowerCase(),
  twilioAccountSid: str('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: str('TWILIO_AUTH_TOKEN'),
  twilioFromNumber: str('TWILIO_FROM_NUMBER'),
  msg91AuthKey: str('MSG91_AUTH_KEY'),
  msg91TemplateId: str('MSG91_TEMPLATE_ID'),
  msg91SenderId: str('MSG91_SENDER_ID'),

  // ---- Results policy -------------------------------------------------
  /**
   * 'after-close' (default) withholds tallies until the authority closes the
   * election, matching real polling practice -- a live count visibly steers
   * later voters. 'live' publishes them continuously, which is useful for
   * demos and transparency exercises.
   */
  resultsVisibility: (str('RESULTS_VISIBILITY', 'after-close') || 'after-close').toLowerCase(),

  // ---- Storage (optional) ---------------------------------------------
  upstashUrl: str('UPSTASH_REDIS_REST_URL'),
  upstashToken: str('UPSTASH_REDIS_REST_TOKEN'),

  // ---- Registry -------------------------------------------------------
  /** Inline registry JSON, for platforms where a file is inconvenient. */
  voterRegistryJson: str('VOTER_REGISTRY_JSON'),
  /** Explicit path to the roll, e.g. a Docker secret or mounted volume. */
  voterRegistryPath: str('VOTER_REGISTRY_PATH'),

  // ---- Dev conveniences (refused in production) ------------------------
  devEchoOtp: bool('DEV_ECHO_OTP', false),
};

/** Secrets that must exist and be long enough for the app to run at all. */
const REQUIRED_SECRETS = [
  ['SESSION_SECRET', env.sessionSecret],
  ['NULLIFIER_SECRET', env.nullifierSecret],
  ['AADHAAR_PEPPER', env.aadhaarPepper],
];

const REQUIRED_CHAIN = [
  ['RPC_URL', env.rpcUrl],
  ['CONTRACT_ADDRESS', env.contractAddress],
  ['RELAYER_PRIVATE_KEY', env.relayerPrivateKey],
];

/**
 * Non-throwing configuration audit. Powers /api/health and lets an operator
 * see exactly what is missing instead of guessing from a stack trace.
 */
function configReport() {
  const missing = [];
  const warnings = [];

  for (const [name, value] of [...REQUIRED_SECRETS, ...REQUIRED_CHAIN]) {
    if (!value) missing.push(name);
  }

  for (const [name, value] of REQUIRED_SECRETS) {
    if (value && value.length < MIN_SECRET_LENGTH) {
      warnings.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
    }
  }

  if (env.isProduction) {
    if (env.otpTransport === 'console') {
      warnings.push('OTP_TRANSPORT=console in production: one-time codes are only written to logs');
    }
    if (env.devEchoOtp) {
      warnings.push('DEV_ECHO_OTP is set in production and will be ignored');
    }
    if (!env.upstashUrl) {
      warnings.push('No Upstash Redis configured: rate limits are per-instance only');
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

/** Throws a 503-shaped error listing everything that is unset. */
function assertConfigured() {
  const report = configReport();
  if (report.ok) return;

  const error = new Error(`Server is not configured. Missing: ${report.missing.join(', ')}`);
  error.statusCode = 503;
  error.code = 'NOT_CONFIGURED';
  error.details = { missing: report.missing };
  throw error;
}

module.exports = { env, configReport, assertConfigured, MIN_SECRET_LENGTH };
