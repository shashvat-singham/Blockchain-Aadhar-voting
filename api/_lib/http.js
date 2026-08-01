'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Thin HTTP helpers shared by every serverless function: consistent JSON
 * envelopes, method routing, security headers, and an error boundary that
 * never leaks an internal message to the client.
 */

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'Not permitted') => new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message);
const conflict = (message, details) => new ApiError(409, 'CONFLICT', message, details);
const tooManyRequests = (message, retryAfterSeconds) =>
  new ApiError(429, 'RATE_LIMITED', message, { retryAfterSeconds });
const unavailable = (message, details) => new ApiError(503, 'UNAVAILABLE', message, details);

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Nothing here is cacheable: every response is either a secret or a live tally.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function sendJson(res, statusCode, payload) {
  applySecurityHeaders(res);
  res.status(statusCode).json(payload);
}

/** Best-effort client identity for rate limiting behind Vercel's proxy. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/** Vercel parses JSON bodies, but be defensive about strings and empties. */
function readJsonBody(req) {
  const { body } = req;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      throw badRequest('Request body is not valid JSON');
    }
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return body;
}

/**
 * Wraps a handler with method allow-listing and an error boundary.
 *
 * @param {Record<string, Function>} handlers Map of METHOD -> handler.
 */
function route(handlers) {
  const allowed = Object.keys(handlers).map((m) => m.toUpperCase());
  if (!allowed.includes('OPTIONS')) allowed.push('OPTIONS');

  return async function handler(req, res) {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);

    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS' && !handlers.OPTIONS) {
      applySecurityHeaders(res);
      res.setHeader('Allow', allowed.join(', '));
      return res.status(204).end();
    }

    const impl = handlers[method];
    if (!impl) {
      res.setHeader('Allow', allowed.join(', '));
      return sendJson(res, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: `${method} is not supported here`, requestId },
      });
    }

    try {
      await impl(req, res, { requestId });
    } catch (error) {
      const statusCode = error.statusCode || 500;

      if (statusCode >= 500) {
        // Full detail to the platform log, never to the caller.
        console.error(`[${requestId}] ${method} ${req.url} failed:`, error);
      } else {
        console.warn(`[${requestId}] ${method} ${req.url} -> ${statusCode} ${error.code || ''}`);
      }

      if (res.headersSent) return;

      if (statusCode === 429 && error.details?.retryAfterSeconds) {
        res.setHeader('Retry-After', String(error.details.retryAfterSeconds));
      }

      sendJson(res, statusCode, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: statusCode >= 500 ? 'Something went wrong. Please try again.' : error.message,
          details: statusCode >= 500 ? undefined : error.details,
          requestId,
        },
      });
    }
  };
}

module.exports = {
  ApiError,
  route,
  sendJson,
  readJsonBody,
  clientIp,
  applySecurityHeaders,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  unavailable,
};
