/**
 * The voting flow: identity → one-time code → ballot → receipt.
 *
 * Everything blockchain-related happens on the server. This file never touches
 * `window.ethereum`, never asks the visitor to install anything, and never
 * needs them to hold funds.
 */

import { api, session, ApiError } from './api.js';
import { $, show, showMessage, clearMessage, withBusy, truncateHash, attachCopy } from './ui.js';

const steps = {
  identity: $('#step-identity'),
  otp: $('#step-otp'),
  ballot: $('#step-ballot'),
  receipt: $('#step-receipt'),
};

const state = {
  challengeToken: null,
  config: null,
};

function goToStep(name) {
  for (const [key, node] of Object.entries(steps)) show(node, key === name);
  // Move focus to the new heading so keyboard and screen-reader users are not
  // left where the previous step used to be.
  steps[name].querySelector('h1')?.setAttribute('tabindex', '-1');
  steps[name].querySelector('h1')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Maps an API failure onto the step where the voter can actually act on it. */
function reportError(container, error) {
  const isTerminal = ['ALREADY_VOTED', 'VOTING_ENDED', 'NOT_LIVE', 'VOTING_NOT_STARTED'].includes(error.code);

  showMessage(container, {
    kind: isTerminal ? 'warn' : 'error',
    title: isTerminal ? 'Cannot continue' : 'Something went wrong',
    text: error.message,
  });

  if (error.code === 'ALREADY_VOTED') session.clear();
}

/* ------------------------------------------------------------------ setup */

async function loadConfig() {
  try {
    state.config = await api.config();

    $('#otp-length').textContent = state.config.auth.otpLength;
    $('#otp-expiry').textContent = Math.max(1, Math.round(state.config.auth.otpTtlSeconds / 60));
  } catch {
    // Cosmetic only — the defaults in the markup stay correct enough to use.
  }
}

/**
 * Surfaces a service problem before the voter has typed anything, rather than
 * failing them halfway through the flow.
 */
async function checkService() {
  let health;
  try {
    // Returns the body on 503 too, so we can read *why* it is degraded.
    health = await api.health();
  } catch {
    showMessage('#banner', {
      kind: 'warn',
      title: 'Could not check the election service',
      text: 'We could not confirm the service is healthy. You can still try to vote.',
    });
    return;
  }

  if (health.canAcceptVotes) return;

  // Distinguish "no election exists yet" from "the election is having trouble".
  // Only the second is something a polling officer can help with.
  const notSetUp = health.checks?.config?.missing?.length > 0;

  showMessage('#banner', {
    kind: notSetUp ? 'info' : 'warn',
    title: notSetUp ? 'No election is running yet' : 'Voting is temporarily unavailable',
    text: notSetUp
      ? 'No ballot has been published to the blockchain, so there is nothing to vote on yet.'
      : 'The election service is not accepting ballots right now. Please tell a polling officer.',
  });

  // The form deliberately stays usable. Disabling it made the page look
  // broken -- keystrokes vanished with no explanation next to the field --
  // and a health check is a snapshot, so a stale one must never be what
  // stops a real voter. Submitting returns a precise reason instead.
}

/* --------------------------------------------------------- step 1: identity */

function formatAadhaarInput(event) {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 12);
  // Group as 0000 0000 0000 — easier to check against a physical card.
  event.target.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

async function onSubmitIdentity(event) {
  event.preventDefault();
  clearMessage('#identity-message');

  const input = $('#aadhaar');
  const aadhaar = input.value.replace(/\D/g, '');

  if (aadhaar.length !== 12) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    showMessage('#identity-message', {
      kind: 'error',
      text: 'Enter all 12 digits of your Aadhaar number.',
    });
    return;
  }
  input.removeAttribute('aria-invalid');

  try {
    const result = await withBusy($('#send-code'), 'Sending code…', () => api.requestOtp(aadhaar));

    state.challengeToken = result.challengeToken;
    $('#phone-hint').textContent = result.phoneHint;
    $('#otp-expiry').textContent = String(Math.max(1, Math.round(result.expiresInSeconds / 60)));

    clearMessage('#otp-message');
    goToStep('otp');
    $('#otp').focus();

    // Local development convenience: the server only echoes the code when
    // DEV_ECHO_OTP is on and it is not running in production.
    if (result.devOtp) {
      showMessage('#otp-message', {
        kind: 'info',
        title: 'Development mode',
        text: `SMS delivery is disabled. Your code is ${result.devOtp}.`,
      });
    }
  } catch (error) {
    reportError('#identity-message', error);
  }
}

/* -------------------------------------------------------------- step 2: OTP */

async function onSubmitOtp(event) {
  event.preventDefault();
  clearMessage('#otp-message');

  const otp = $('#otp').value.replace(/\D/g, '');
  if (otp.length < 4) {
    showMessage('#otp-message', { kind: 'error', text: 'Enter the code from your text message.' });
    return;
  }

  try {
    const result = await withBusy($('#verify-code'), 'Verifying…', () =>
      api.verifyOtp(state.challengeToken, otp)
    );

    session.save(result.sessionToken, result.ward);
    await loadBallot();
  } catch (error) {
    $('#otp').value = '';
    $('#otp').focus();
    reportError('#otp-message', error);
  }
}

/* ----------------------------------------------------------- step 3: ballot */

function renderBallot(ballot) {
  const container = $('#ballot-options');
  container.innerHTML = '';

  const legend = document.createElement('legend');
  legend.className = 'sr-only';
  legend.textContent = `Candidates in ${ballot.ward.label}`;
  container.append(legend);

  if (ballot.candidates.length === 0) {
    showMessage('#ballot-message', {
      kind: 'warn',
      title: 'No candidates',
      text: 'No candidates are standing in your constituency. Please speak to a polling officer.',
    });
    return;
  }

  for (const candidate of ballot.candidates) {
    const label = document.createElement('label');
    label.className = 'ballot__option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'candidate';
    input.value = String(candidate.id);

    const symbol = document.createElement('img');
    symbol.className = 'ballot__symbol';
    symbol.src = candidate.symbolUri || '/images/e-voting-logo.png';
    symbol.alt = `${candidate.party} election symbol`;
    symbol.loading = 'lazy';

    const names = document.createElement('div');
    names.className = 'ballot__names';

    const name = document.createElement('div');
    name.className = 'ballot__candidate';
    name.textContent = candidate.name;

    const party = document.createElement('div');
    party.className = 'ballot__party';
    party.textContent = candidate.party;

    names.append(name, party);

    const check = document.createElement('span');
    check.className = 'ballot__check';
    check.setAttribute('aria-hidden', 'true');

    label.append(input, symbol, names, check);
    container.append(label);
  }

  container.addEventListener('change', () => {
    $('#cast-vote').disabled = !container.querySelector('input:checked');
  });
}

async function loadBallot() {
  const stored = session.load();
  if (!stored?.token) {
    goToStep('identity');
    return;
  }

  clearMessage('#ballot-message');

  try {
    const ballot = await api.ballot(stored.token);

    $('#ward-label').textContent = ballot.ward.label;
    if (ballot.election?.name) $('#election-name').textContent = ballot.election.name;

    renderBallot(ballot);
    $('#cast-vote').disabled = true;
    goToStep('ballot');
  } catch (error) {
    if (error.status === 401) session.clear();
    goToStep(error.status === 401 ? 'identity' : 'ballot');
    reportError(error.status === 401 ? '#identity-message' : '#ballot-message', error);
  }
}

/* ---------------------------------------------------------- step 4: receipt */

function renderReceipt(receipt) {
  $('#receipt-tx').textContent = truncateHash(receipt.txHash, 14, 12);
  $('#receipt-tx').title = receipt.txHash;
  $('#receipt-block').textContent = receipt.blockNumber ?? '—';
  $('#receipt-confirmations').textContent = receipt.confirmations ?? '—';

  const link = $('#explorer-link');
  if (receipt.explorerUrl) {
    link.href = receipt.explorerUrl;
    link.hidden = false;
  }

  attachCopy($('#copy-tx'), () => receipt.txHash);
  goToStep('receipt');
}

async function onSubmitBallot(event) {
  event.preventDefault();
  clearMessage('#ballot-message');

  const selected = $('#ballot-options input:checked');
  if (!selected) return;

  const option = selected.closest('.ballot__option');
  const candidateName = option.querySelector('.ballot__candidate').textContent;

  // A vote is irreversible; make the voter say so out loud once.
  if (!window.confirm(`Cast your vote for ${candidateName}?\n\nThis cannot be undone.`)) return;

  const stored = session.load();
  if (!stored?.token) {
    goToStep('identity');
    return;
  }

  try {
    const result = await withBusy($('#cast-vote'), 'Recording on the blockchain…', () =>
      api.vote(stored.token, Number(selected.value))
    );

    // The session has served its only purpose; do not leave it in the tab.
    session.clear();
    renderReceipt(result.receipt);
  } catch (error) {
    if (error.status === 401) {
      session.clear();
      goToStep('identity');
      reportError('#identity-message', error);
      return;
    }
    reportError('#ballot-message', error);
  }
}

/* ---------------------------------------------------------------- wiring */

function resetToIdentity() {
  session.clear();
  state.challengeToken = null;
  $('#identity-form').reset();
  $('#otp-form').reset();
  clearMessage('#identity-message');
  goToStep('identity');
  $('#aadhaar').focus();
}

async function init() {
  $('#aadhaar').addEventListener('input', formatAadhaarInput);
  $('#identity-form').addEventListener('submit', onSubmitIdentity);
  $('#otp-form').addEventListener('submit', onSubmitOtp);
  $('#ballot-form').addEventListener('submit', onSubmitBallot);
  $('#restart-identity').addEventListener('click', resetToIdentity);
  $('#abandon').addEventListener('click', resetToIdentity);

  $('#otp').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '');
  });

  await loadConfig();
  await checkService();

  // Resume a ballot if the tab was reloaded mid-vote.
  if (session.load()?.token) await loadBallot();
}

init();
