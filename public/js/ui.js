/** Small DOM helpers shared by the pages. Kept dependency-free on purpose. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Sets text content; `escape` is unnecessary because we never assign HTML. */
export function setText(selector, value, root = document) {
  const node = $(selector, root);
  if (node) node.textContent = value;
}

export function show(node, visible = true) {
  if (typeof node === 'string') node = $(node);
  if (node) node.hidden = !visible;
}

/**
 * Renders a message into a live region. Assertive for errors so a screen
 * reader interrupts rather than queueing behind other announcements.
 */
export function showMessage(container, { kind = 'info', title, text }) {
  if (typeof container === 'string') container = $(container);
  if (!container) return;

  container.innerHTML = '';
  container.hidden = false;
  container.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  container.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

  const box = document.createElement('div');
  box.className = `message message--${kind}`;

  const body = document.createElement('div');
  if (title) {
    const strong = document.createElement('strong');
    strong.textContent = title;
    body.append(strong);
  }
  body.append(document.createTextNode(text));

  box.append(body);
  container.append(box);
}

export function clearMessage(container) {
  if (typeof container === 'string') container = $(container);
  if (!container) return;
  container.innerHTML = '';
  container.hidden = true;
}

/** Disables a button and swaps its label for a spinner while `task` runs. */
export async function withBusy(button, label, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="button__spinner" aria-hidden="true"></span><span>${label}</span>`;

  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/** Formats a unix timestamp in the viewer's own locale and timezone. */
export function formatTime(unixSeconds) {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export const formatNumber = (value) => Number(value ?? 0).toLocaleString();

/** "0x1234…abcd" for long hex values that must stay recognisable. */
export function truncateHash(hash, lead = 10, tail = 8) {
  if (!hash || hash.length <= lead + tail + 1) return hash || '—';
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

/** Copy-to-clipboard with an inline confirmation, degrading quietly. */
export function attachCopy(button, getValue) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getValue());
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = original;
      }, 1600);
    } catch {
      // Clipboard access can be blocked; the value is visible on screen anyway.
    }
  });
}
