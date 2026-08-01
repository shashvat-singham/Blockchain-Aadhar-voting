'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Presentation metadata for the ballot: ward labels and party symbol images.
 *
 * Candidate names, parties and -- critically -- vote counts are always read
 * from the contract, never from here. This file only supplies the things the
 * chain has no opinion about, so it can never disagree with the tally.
 */

let cache = null;

function load() {
  if (cache) return cache;

  const filePath = path.join(process.cwd(), 'config', 'election.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const wardLabels = new Map((parsed.wards || []).map((w) => [w.id, w.label]));

  // Keyed by "ward|name" so two candidates with the same name in different
  // wards keep their own symbol.
  const symbols = new Map((parsed.candidates || []).map((c) => [`${c.ward}|${c.name}`, c.symbolUri]));

  cache = { raw: parsed, wardLabels, symbols };
  return cache;
}

const wardLabel = (wardId) => load().wardLabels.get(wardId) || wardId;
const symbolFor = (wardId, name) => load().symbols.get(`${wardId}|${name}`) || '/images/ballot-default.svg';
const wards = () => load().raw.wards || [];
const candidateSeed = () => load().raw.candidates || [];
const electionSeedName = () => load().raw.name;
const pollingWindow = () => load().raw.pollingWindow || { opensAt: 0, durationHours: 168 };

module.exports = { wardLabel, symbolFor, wards, candidateSeed, electionSeedName, pollingWindow };
