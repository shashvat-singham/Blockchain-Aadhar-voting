'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { env } = require('./env');
const { registryKey } = require('./crypto');
const { unavailable } = require('./http');

/**
 * The electoral roll.
 *
 * Records are keyed by HMAC(AADHAAR_PEPPER, aadhaar) so the file never
 * contains a raw Aadhaar number. Source order:
 *
 *   1. VOTER_REGISTRY_JSON env var (inline JSON) -- preferred on Vercel,
 *      because it keeps the roll in the platform secret store rather than git
 *   2. VOTER_REGISTRY_PATH -- a mounted file or Docker secret
 *   3. data/voters.json on disk -- convenient for local development
 *
 * The file still holds phone numbers and is therefore PII: treat it as a
 * secret, keep it out of version control, and generate it with
 * `npm run voters:hash`.
 *
 * Loaded once per warm instance; a roll change requires a redeploy, which is
 * the desired property for an electoral roll mid-election.
 */

let cache = null;

function parse(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Voter registry at ${source} is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.voters !== 'object') {
    throw new Error(`Voter registry at ${source} must be { "version": 1, "voters": { ... } }`);
  }

  return { voters: parsed.voters, count: Object.keys(parsed.voters).length, source };
}

function load() {
  if (cache) return cache;

  if (env.voterRegistryJson) {
    cache = parse(env.voterRegistryJson, 'VOTER_REGISTRY_JSON');
    return cache;
  }

  const filePath = env.voterRegistryPath || path.join(process.cwd(), 'data', 'voters.json');
  if (!fs.existsSync(filePath)) {
    throw unavailable(
      env.voterRegistryPath
        ? `Voter registry not found at VOTER_REGISTRY_PATH (${filePath}).`
        : 'Voter registry is not available. Provide VOTER_REGISTRY_JSON, set VOTER_REGISTRY_PATH, or generate data/voters.json with `npm run voters:hash`.'
    );
  }

  cache = parse(fs.readFileSync(filePath, 'utf8'), filePath);
  return cache;
}

/**
 * @param {string} aadhaar Normalised 12-digit number.
 * @returns {{ ward: string, phone: string, eligible: boolean } | null}
 */
function findVoter(aadhaar) {
  const { voters } = load();
  const record = voters[registryKey(aadhaar)];
  if (!record) return null;

  return {
    ward: record.ward,
    phone: record.phone,
    // Absent `eligible` means eligible; only an explicit false excludes.
    eligible: record.eligible !== false,
  };
}

/** Non-throwing summary for /api/health. */
function registryStatus() {
  try {
    const { count, source } = load();
    return { available: true, voters: count, source };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

module.exports = { findVoter, registryStatus };
