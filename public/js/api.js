/**
 * Thin client for the voting API.
 *
 * There is deliberately no wallet code anywhere in this file — no
 * `window.ethereum`, no provider detection, no "please install MetaMask".
 * The browser talks to our own origin over HTTPS and nothing else; the
 * blockchain transaction is signed and paid for server-side.
 */

/** Structured error so callers can branch on a code instead of a message. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TIMEOUT_MS = 30_000;

/**
 * @param {object} [options]
 * @param {number[]} [options.acceptStatuses] Non-2xx statuses to return rather
 *        than throw. /api/health answers 503 with the diagnosis in the body,
 *        so for that route the error status is the useful response.
 */
async function request(path, { method = 'GET', body, token, acceptStatuses = [] } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      credentials: 'omit',
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new ApiError(
        0,
        'TIMEOUT',
        'The server took too long to respond. Your vote may still be processing — check the results page before retrying.'
      );
    }
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }

  // 204 and other empty bodies are legitimate; do not treat them as failures.
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', 'The server sent a response we could not read.');
    }
  }

  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const error = payload.error || {};
    throw new ApiError(
      response.status,
      error.code || 'ERROR',
      error.message || `Request failed (${response.status})`,
      error.details
    );
  }

  return payload;
}

export const api = {
  config: () => request('/api/config'),
  // 503 is a valid, informative answer here — do not treat it as a failure.
  health: () => request('/api/health', { acceptStatuses: [503] }),
  results: () => request('/api/results'),

  requestOtp: (aadhaar) => request('/api/auth/request-otp', { method: 'POST', body: { aadhaar } }),
  verifyOtp: (challengeToken, otp) =>
    request('/api/auth/verify-otp', { method: 'POST', body: { challengeToken, otp } }),

  ballot: (token) => request('/api/ballot', { token }),
  vote: (token, candidateId) => request('/api/vote', { method: 'POST', body: { candidateId }, token }),
};

/**
 * Session storage, not local storage: a polling-booth browser is shared, and
 * the voting session must not outlive the tab.
 */
const SESSION_KEY = 'aadhaar-voting.session';

export const session = {
  save(token, ward) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, ward }));
  },
  load() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
  },
};
