'use strict';

/**
 * Standalone HTTP server.
 *
 * Vercel is the primary deployment target and does not use this file — there,
 * `public/` is served from the edge and each file in `api/` becomes its own
 * function. This server exists so the identical code can run anywhere else:
 * Docker, a VM, or a laptop with nothing but Node installed.
 *
 *   npm run dev     NODE_ENV=development, modules reload on every request
 *   npm start       production mode
 *
 * Routing deliberately mirrors Vercel's file-system convention, so a route
 * that works here works there.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_DEV = (process.env.NODE_ENV || 'development') !== 'production';
const MAX_BODY_BYTES = 64 * 1024;

/* -------------------------------------------------------------------- env */

/**
 * Loads .env.local when present. Real environment variables always win, so a
 * container's configuration is never overridden by a stray file.
 */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

/* ----------------------------------------------------------------- static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

/** Mirrors the headers vercel.json applies at the edge. */
function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Only meaningful behind TLS; harmless otherwise, and containers usually sit
  // behind a proxy that terminates it.
  if (!IS_DEV) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

/**
 * Resolves a URL path to a file inside public/, or null if it escapes the
 * document root. Without the containment check, `/../.env.local` would be
 * readable.
 */
async function resolveStatic(pathname) {
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const resolved = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(requested)}`);

  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;

  for (const candidate of [resolved, `${resolved}.html`, path.join(resolved, 'index.html')]) {
    try {
      const stats = await fsp.stat(candidate);
      if (stats.isFile()) return { filePath: candidate, stats };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function serveStatic(pathname, req, res) {
  const found = await resolveStatic(pathname);

  if (!found) {
    securityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 — Not found</h1><p><a href="/">Go to the voting page</a></p>');
    return;
  }

  const { filePath, stats } = found;
  const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

  securityHeaders(res);
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader(
    'Cache-Control',
    // Images are content-addressed by name and rarely change; HTML/CSS/JS must
    // never be served stale after a redeploy.
    !IS_DEV && contentType.startsWith('image/') ? 'public, max-age=604800' : 'no-cache'
  );

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return;
  }

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const shouldCompress = acceptsGzip && COMPRESSIBLE.test(contentType) && stats.size > 1024;

  if (shouldCompress) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  } else {
    res.setHeader('Content-Length', stats.size);
  }

  res.writeHead(200);

  try {
    const source = fs.createReadStream(filePath);
    await (shouldCompress ? pipeline(source, zlib.createGzip(), res) : pipeline(source, res));
  } catch (error) {
    // A client that navigates away mid-response is normal, not an error.
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && error.code !== 'EPIPE') throw error;
  }
}

/* -------------------------------------------------------------------- api */

/** Maps /api/auth/request-otp to api/auth/request-otp.js, exactly as Vercel does. */
function resolveHandler(pathname) {
  const relative = pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  if (!relative) return null;

  const segments = relative.split('/');
  // Underscore-prefixed paths are shared libraries, never routes.
  if (segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('_'))) return null;

  for (const candidate of [`${relative}.js`, path.join(relative, 'index.js')]) {
    const filePath = path.resolve(API_DIR, candidate);
    if (filePath.startsWith(API_DIR + path.sep) && fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Adds the `res.status().json()` shape the handlers expect from Vercel. */
function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

/** In development, drop the cache so edits apply without a restart. */
function loadHandler(handlerPath) {
  if (IS_DEV) {
    delete require.cache[require.resolve(handlerPath)];
    const libDir = path.join(API_DIR, '_lib');
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
  }
  return require(handlerPath);
}

async function serveApi(pathname, req, res) {
  const handlerPath = resolveHandler(pathname);

  if (!handlerPath) {
    decorate(res)
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: `No API route for ${pathname}` } });
    return;
  }

  const raw = await readBody(req);
  if (raw && /json/i.test(req.headers['content-type'] || '')) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      decorate(res)
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' } });
      return;
    }
  } else {
    req.body = raw || undefined;
  }

  await loadHandler(handlerPath)(req, decorate(res));
}

/* ----------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.on('finish', () => {
    // No query string and no body: request logs must not become a PII sink.
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    if (url.pathname.startsWith('/api/')) {
      await serveApi(url.pathname, req, res);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url.pathname, req, res);
    } else {
      securityHeaders(res);
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    }
  } catch (error) {
    console.error(`Unhandled error on ${url.pathname}:`, error);
    if (res.headersSent) {
      res.end();
      return;
    }
    decorate(res)
      .status(error.statusCode || 500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  }
});

// Slightly above a typical 60s load-balancer idle timeout, so the proxy closes
// connections rather than us racing it and producing 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(PORT, HOST, () => {
  console.log(`Aadhaar Voting listening on http://${HOST}:${PORT} (${IS_DEV ? 'development' : 'production'})`);
  console.log(`Health: http://${HOST}:${PORT}/api/health`);
});

/**
 * Graceful shutdown. A ballot may be mid-flight waiting for a transaction
 * receipt; killing the process would leave the voter without their confirmation
 * even though the vote was recorded.
 */
function shutdown(signal) {
  console.log(`${signal} received, finishing in-flight requests…`);

  const timer = setTimeout(() => {
    console.error('Shutdown timed out; forcing exit.');
    process.exit(1);
  }, 30_000);
  timer.unref();

  server.close((error) => {
    if (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
    console.log('Closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
