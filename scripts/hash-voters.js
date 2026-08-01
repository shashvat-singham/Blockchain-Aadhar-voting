'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Converts a plaintext electoral roll into the hashed registry the app reads.
 *
 *   npm run voters:hash -- data/voters.sample.csv
 *
 * Input columns:  aadhaar,ward,phone,eligible
 * Output:         data/voters.json, keyed by HMAC(AADHAAR_PEPPER, aadhaar)
 *
 * Aadhaar numbers are only 12 digits, so a plain SHA-256 of the roll would be
 * exhaustively searchable in minutes. The pepper is what makes the digests
 * useless to anyone who steals the file without also stealing the secret --
 * which is why AADHAAR_PEPPER must live in a secret store, not in the repo.
 */

// 12 digits. The UIDAI convention that real numbers never start with 0 or 1 is
// reported as a warning rather than enforced, so synthetic numbers can be used
// for testing and training rolls. See normaliseAadhaar in api/_lib/crypto.js.
const AADHAAR_PATTERN = /^\d{12}$/;
const SYNTHETIC_PATTERN = /^[01]/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function registryKey(pepper, aadhaar) {
  return crypto
    .createHmac('sha256', pepper)
    .update('aadhaar-registry:v1')
    .update('\x1f')
    .update(aadhaar)
    .digest('hex');
}

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = trimmed.split(',').map((field) => field.trim());
    if (fields[0].toLowerCase() === 'aadhaar') return; // header row

    const [aadhaar, ward, phone, eligible] = fields;
    rows.push({ lineNumber: index + 1, aadhaar, ward, phone, eligible });
  });

  return rows;
}

function main() {
  const pepper = process.env.AADHAAR_PEPPER;
  if (!pepper || pepper.length < 32) {
    console.error('AADHAAR_PEPPER must be set and at least 32 characters.');
    console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  const inputPath = process.argv[2] || path.join('data', 'voters.sample.csv');
  const outputPath = process.argv[3] || path.join('data', 'voters.json');

  if (!fs.existsSync(inputPath)) {
    console.error(`No such file: ${inputPath}`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(inputPath, 'utf8'));
  const wards = new Set(
    JSON.parse(fs.readFileSync(path.join('config', 'election.json'), 'utf8')).wards.map((w) => w.id)
  );

  const voters = {};
  const errors = [];
  const warnings = [];
  const seen = new Map();

  for (const row of rows) {
    const where = `${inputPath}:${row.lineNumber}`;

    if (!AADHAAR_PATTERN.test(row.aadhaar || '')) {
      errors.push(`${where}: "${row.aadhaar}" is not 12 digits`);
      continue;
    }
    if (SYNTHETIC_PATTERN.test(row.aadhaar)) {
      // Accepted, but worth flagging: a real roll should not contain these.
      warnings.push(`${where}: "${row.aadhaar}" starts with 0 or 1, so it is not a real Aadhaar number`);
    }
    if (!wards.has(row.ward)) {
      errors.push(`${where}: ward "${row.ward}" is not declared in config/election.json`);
      continue;
    }
    if (!E164_PATTERN.test(row.phone || '')) {
      errors.push(`${where}: phone "${row.phone}" must be E.164, e.g. +919876543210`);
      continue;
    }

    // A duplicated number would silently overwrite -- and one person would end
    // up with whichever ward happened to be last in the file.
    if (seen.has(row.aadhaar)) {
      errors.push(`${where}: duplicate of line ${seen.get(row.aadhaar)}`);
      continue;
    }
    seen.set(row.aadhaar, row.lineNumber);

    voters[registryKey(pepper, row.aadhaar)] = {
      ward: row.ward,
      phone: row.phone,
      eligible: String(row.eligible).toLowerCase() !== 'false',
    };
  }

  if (errors.length > 0) {
    console.error(`Refusing to write a partial roll. ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    // Lets an operator tell at a glance whether a roll matches the live pepper,
    // without the file revealing the pepper itself.
    pepperFingerprint: crypto.createHash('sha256').update(pepper).digest('hex').slice(0, 12),
    voters,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  if (warnings.length > 0) {
    console.warn(`${warnings.length} warning(s):`);
    for (const warning of warnings) console.warn(`  ${warning}`);
    console.warn('');
  }

  const eligible = Object.values(voters).filter((v) => v.eligible).length;
  console.log(`Wrote ${outputPath}: ${Object.keys(voters).length} voters (${eligible} eligible).`);
  console.log('The output still contains phone numbers. Treat it as PII: keep it out of git,');
  console.log('and prefer supplying it through VOTER_REGISTRY_JSON in production.');
  console.log(`\nDelete the plaintext roll when you are done:  rm ${inputPath}`);
}

main();
