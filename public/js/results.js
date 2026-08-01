/**
 * Public results.
 *
 * Reads /api/results, which in turn reads the contract. The verification panel
 * gives visitors everything they need to reproduce these numbers themselves
 * from a public RPC — the point being that this page is a convenience, not the
 * source of truth.
 */

import { api } from './api.js';
import { $, showMessage, formatTime, formatNumber, attachCopy } from './ui.js';

/** Poll while the election is live; a closed election never changes again. */
const REFRESH_MS = 20_000;
let timer = null;

function renderPhase(election, tallyVisible) {
  const badge = $('#phase-badge');
  const dot = '<span class="badge__dot"></span>';

  if (election.isLive) {
    badge.className = 'badge badge--ok';
    badge.innerHTML = `${dot} Polling open`;
  } else if (election.phase === 'Closed') {
    badge.className = 'badge badge--neutral';
    badge.innerHTML = `${dot} Polling closed · final`;
  } else if (election.phase === 'Setup') {
    badge.className = 'badge badge--warn';
    badge.innerHTML = `${dot} Not yet open`;
  } else {
    badge.className = 'badge badge--warn';
    badge.innerHTML = `${dot} Polling paused`;
  }

  if (!tallyVisible) badge.insertAdjacentText('beforeend', ' · counts withheld');
}

function renderWard(ward, tallyVisible) {
  const card = document.createElement('section');
  card.className = 'card ward';

  const head = document.createElement('div');
  head.className = 'ward__head';

  const title = document.createElement('h2');
  title.textContent = ward.label;

  const count = document.createElement('span');
  count.className = 'muted';
  count.textContent = tallyVisible ? `${formatNumber(ward.totalVotes)} votes` : 'Counts published after polling closes';

  head.append(title, count);
  card.append(head);

  // Percentages are relative to the ward, so a small ward is not dwarfed by a
  // large one on the same page.
  const maxVotes = tallyVisible ? Math.max(1, ...ward.candidates.map((c) => c.votes || 0)) : 1;

  for (const candidate of ward.candidates) {
    const row = document.createElement('div');
    row.className = 'result-row';
    if (tallyVisible && ward.leader === candidate.name) row.classList.add('result-row--leading');

    const top = document.createElement('div');
    top.className = 'result-row__top';

    const symbol = document.createElement('img');
    symbol.className = 'result-row__symbol';
    symbol.src = candidate.symbolUri || '/images/e-voting-logo.png';
    symbol.alt = '';
    symbol.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'result-row__name';
    name.textContent = candidate.name;
    if (!candidate.active) name.textContent += ' (withdrawn)';

    const party = document.createElement('span');
    party.className = 'result-row__party';
    party.textContent = candidate.party;

    const votes = document.createElement('span');
    votes.className = 'result-row__count';
    const share = tallyVisible && ward.totalVotes > 0 ? Math.round((candidate.votes / ward.totalVotes) * 100) : 0;
    votes.textContent = tallyVisible ? `${formatNumber(candidate.votes)} · ${share}%` : '—';

    top.append(symbol, name, party, votes);

    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.setAttribute('role', 'img');
    meter.setAttribute(
      'aria-label',
      tallyVisible
        ? `${candidate.name}, ${candidate.party}: ${candidate.votes} votes, ${share}% of this constituency`
        : `${candidate.name}, ${candidate.party}: count not yet published`
    );

    const fill = document.createElement('div');
    fill.className = 'meter__fill';
    fill.style.width = tallyVisible ? `${((candidate.votes || 0) / maxVotes) * 100}%` : '0%';
    meter.append(fill);

    row.append(top, meter);
    card.append(row);
  }

  return card;
}

function renderVerification(verification) {
  if (!verification.contractAddress) return;

  $('#verify-address').textContent = verification.contractAddress;
  $('#verify-chain').textContent = verification.chainId || 'unknown';
  $('#verify-rpc').textContent = verification.rpcUrl || 'Ask the election authority for a public endpoint';

  attachCopy($('#copy-address'), () => verification.contractAddress);

  if (verification.explorerAddressUrl) {
    const link = $('#verify-explorer');
    link.href = `${verification.explorerAddressUrl}/${verification.contractAddress}`;
    link.hidden = false;
  }

  $('#verification').hidden = false;
}

async function refresh() {
  try {
    const data = await api.results();

    if (data.election?.name) {
      document.title = `Results · ${data.election.name}`;
      $('#election-name').textContent = data.election.name;
    }

    renderPhase(data.election, data.tallyVisible);

    $('#stat-total').textContent = formatNumber(data.turnout.totalVotes);
    $('#stat-wards').textContent = formatNumber(data.wards.length);
    $('#stat-closes').textContent = formatTime(data.election.closesAt);
    $('#stats').hidden = false;

    const container = $('#wards');
    container.innerHTML = '';

    if (data.wards.length === 0) {
      showMessage('#message', {
        kind: 'info',
        title: 'No ballot published yet',
        text: 'The election authority has not added any candidates to this election.',
      });
    } else {
      if (!data.tallyVisible) {
        showMessage('#message', {
          kind: 'info',
          title: 'Counts are withheld until polling closes',
          text: `${data.tallyWithheldReason} Turnout is published throughout, and the underlying transactions are public on-chain.`,
        });
      }
      for (const ward of data.wards) container.append(renderWard(ward, data.tallyVisible));
    }

    renderVerification(data.verification);

    // Stop polling once the result is final; nothing can change after that.
    if (!data.election.isLive && timer) {
      clearInterval(timer);
      timer = null;
    }
  } catch (error) {
    $('#wards').innerHTML = '';
    showMessage('#message', {
      kind: 'error',
      title: 'Could not load results',
      text: error.message,
    });
  }
}

refresh();
timer = setInterval(refresh, REFRESH_MS);

// Refreshing a hidden tab burns quota for nobody's benefit.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
