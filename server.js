#!/usr/bin/env node
/**
 * Farsanime media proxy — v3 (Node.js / Fly.io)
 *
 * نسخهٔ ۲ یک Cloudflare Worker بود؛ Fly.io کد Worker را اجرا نمی‌کند، پس همین
 * منطق به یک سرور Node.js بدون dependency منتقل شده است (فقط ماژول‌های داخلی).
 *
 * Usage:
 *   GET /?url=<encoded-target>&range=bytes%3D0-1023
 *   GET /?url=<encoded-target>&range=0-1023
 *   GET /?url=<encoded-target>
 *   GET /healthz
 *
 * Environment:
 *   PROXY_KEY            required, sent as x-proxy-key
 *   ALLOWED_HOSTS        optional, default: farsanime.ir,di.farsanime.ir
 *   ALLOWED_CLIENT_IPS   optional, empty = allow every client IP
 *   PORT                 optional, default 8080
 *   UPSTREAM_REFERER     optional, default https://farsanime.ir/
 *   FETCH_TIMEOUT_MS     optional, default 15000 (زمان انتظار برای هدرهای upstream)
 *   MAX_REDIRECTS        optional, default 4
 *
 * بدنهٔ رسانه هیچ‌وقت بافر نمی‌شود؛ status، هدرها و استریم upstream دست‌نخورده
 * برمی‌گردند، همراه با هدرهای no-store.
 *
 * تغییرات نسبت به نسخهٔ ۲ (Worker):
 *   • چک کلید با مقایسهٔ ثابت‌زمان روی هش (نشت طول کلید حذف شد)
 *   • کنترل پورت در ریدایرکت‌ها (قبلاً فقط https و هاست چک می‌شد)
 *   • تایم‌اوت گرفتن هدرهای upstream + بستن اتصال upstream با قطع شدن کلاینت
 *   • استریم با backpressure واقعی (pipeline) به‌جای کار دستی
 *   • `/healthz` برای health check فای، و خاموشی تمیز روی SIGTERM
 *   • لاگ یک‌خطی برای هر درخواست (بدون ثبت کلید)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_ALLOWED_HOSTS = ['farsanime.ir', 'di.farsanime.ir'];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const PORT = Number(process.env.PORT || 8080);
const PROXY_KEY = String(process.env.PROXY_KEY || '').trim();
const UPSTREAM_REFERER = String(process.env.UPSTREAM_REFERER || 'https://farsanime.ir/');
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.FETCH_TIMEOUT_MS || 15000));
const MAX_REDIRECTS = Math.max(0, Math.min(10, Number(process.env.MAX_REDIRECTS || 4)));
const MAX_URL_LENGTH = 8192;
const USER_AGENT = 'Mozilla/5.0 (compatible; FarsanimeMediaRelay/3.0)';

const ALLOWED_CLIENT_IPS = parseList(process.env.ALLOWED_CLIENT_IPS);

// ============================================================
// SERVER
// ============================================================

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log('error', req, 500, `${err?.name || 'Error'}: ${err?.message || err}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal_error' });
    } else {
      res.destroy();
    }
  });
});

async function handleRequest(req, res) {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // --- health -------------------------------------------------
  if (url.pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      uptime_seconds: Math.round(process.uptime()),
    });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'x-proxy-key, range, content-type',
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD, OPTIONS' });
  }

  // --- auth ---------------------------------------------------
  if (!PROXY_KEY) {
    return sendJson(res, 500, { error: 'server_misconfigured' });
  }

  if (!safeEqual(req.headers['x-proxy-key'] || '', PROXY_KEY)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  if (ALLOWED_CLIENT_IPS.length > 0) {
    const ip = clientIp(req);
    if (!ALLOWED_CLIENT_IPS.includes(ip.toLowerCase())) {
      log('deny-ip', req, 403, ip || 'unknown');
      return sendJson(res, 403, { error: 'forbidden_ip' });
    }
  }

  // --- target -------------------------------------------------
  const targetRaw = url.searchParams.get('url');

  if (!targetRaw) {
    return sendJson(res, 400, { error: 'missing_url' });
  }

  if (targetRaw.length > MAX_URL_LENGTH) {
    return sendJson(res, 400, { error: 'url_too_long' });
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    return sendJson(res, 400, { error: 'invalid_url' });
  }

  const targetProblem = checkTargetUrl(target);
  if (targetProblem) {
    return sendJson(res, targetProblem.status, { error: targetProblem.error });
  }

  // --- range --------------------------------------------------
  const explicitRange = url.searchParams.get('range');
  const range = normalizeRange(explicitRange || req.headers.range || '');

  if (explicitRange !== null && !range) {
    return sendJson(res, 400, { error: 'invalid_range' });
  }

  // --- upstream -----------------------------------------------
  const upstreamHeaders = new Headers();
  if (range) upstreamHeaders.set('range', range);
  upstreamHeaders.set('accept-encoding', 'identity');
  upstreamHeaders.set('accept', '*/*');
  upstreamHeaders.set('user-agent', req.headers['user-agent'] || USER_AGENT);
  upstreamHeaders.set('referer', UPSTREAM_REFERER);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetchFollowing(target, upstreamHeaders, req.method, controller.signal);
  } catch (err) {
    clearTimeout(timeout);
    const disallowed = err?.message === 'redirect_not_allowed' || err?.message === 'port_not_allowed';
    log('upstream', req, disallowed ? 403 : 502, `${target.hostname} ${err?.message || err}`);
    return sendJson(res, disallowed ? 403 : 502, {
      error: disallowed ? err.message : 'upstream_fetch_failed',
    });
  }

  clearTimeout(timeout);

  // --- response headers ---------------------------------------
  const headers = {};

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') continue;
    headers[lower] = value;
  }

  delete headers['cache-control'];
  delete headers['expires'];

  headers['cache-control'] = 'no-store';
  headers['cdn-cache-control'] = 'no-store';
  headers['x-proxy-host'] = target.hostname;
  headers['x-proxy-range'] = range || 'none';
  headers['x-proxy-upstream-status'] = String(upstream.status);
  headers['access-control-allow-origin'] = '*';
  headers['access-control-expose-headers'] =
    'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Disposition, ' +
    'X-Proxy-Host, X-Proxy-Range, X-Proxy-Upstream-Status';

  if (range && upstream.status === 206) {
    headers['x-proxy-range-ok'] = '1';
  } else if (range && upstream.status === 200) {
    headers['x-proxy-range-ignored'] = '1';
  }

  const noBody =
    req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304 || !upstream.body;

  res.writeHead(upstream.status, headers);

  if (noBody) {
    res.end();
    log('ok', req, upstream.status, `${target.hostname} ${range || 'full'}`);
    return;
  }

  const source = Readable.fromWeb(upstream.body);
  const abortUpstream = () => source.destroy();
  res.on('close', abortUpstream);

  try {
    await pipeline(source, res);
    log('ok', req, upstream.status, `${target.hostname} ${range || 'full'} ${Date.now() - started}ms`);
  } catch {
    // کلاینت یا upstream اتصال را بست — چیزی برای ارسال نمانده
    res.destroy();
    log('aborted', req, upstream.status, `${target.hostname} ${Date.now() - started}ms`);
  } finally {
    res.off('close', abortUpstream);
  }
}

// ============================================================
// UPSTREAM
// ============================================================

async function fetchFollowing(startUrl, headers, method, signal) {
  let current = startUrl;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    const response = await fetch(current.toString(), {
      method,
      headers,
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');

    if (!location) {
      return response;
    }

    const next = new URL(location, current);

    if (!isAllowedHost(next.hostname)) {
      throw new Error('redirect_not_allowed');
    }

    if (next.protocol !== 'https:') {
      throw new Error('redirect_not_allowed');
    }

    if (next.port && next.port !== '443') {
      throw new Error('port_not_allowed');
    }

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // بدنه قبلاً مصرف شده
      }
    }

    current = next;
  }

  throw new Error('too_many_redirects');
}

function checkTargetUrl(target) {
  if (target.protocol !== 'https:') {
    return { error: 'https_required', status: 400 };
  }

  if (target.username || target.password) {
    return { error: 'credentials_not_allowed', status: 400 };
  }

  if (target.port && target.port !== '443') {
    return { error: 'port_not_allowed', status: 400 };
  }

  if (!isAllowedHost(target.hostname)) {
    return { error: 'host_not_allowed', status: 403 };
  }

  return null;
}

// ============================================================
// HELPERS
// ============================================================

function normalizeRange(value) {
  const raw = String(value || '').trim();

  if (!raw || raw.length > 64) {
    return null;
  }

  const match = /^(?:bytes=)?(\d{0,18})-(\d{0,18})$/.exec(raw);

  if (!match) {
    return null;
  }

  const start = match[1];
  const end = match[2];

  if (start === '' && end === '') {
    return null;
  }

  if (start !== '' && end !== '' && Number(start) > Number(end)) {
    return null;
  }

  return `bytes=${start}-${end}`;
}

function isAllowedHost(hostname) {
  const configured = parseList(process.env.ALLOWED_HOSTS);
  const allowed = configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTS;
  const host = String(hostname || '').toLowerCase();

  return allowed.some((entry) => host === entry || host.endsWith('.' + entry));
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clientIp(req) {
  const fly = req.headers['fly-client-ip'];
  if (fly) return String(fly).trim();

  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();

  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function safeEqual(a, b) {
  // مقایسهٔ ثابت‌زمان روی هش تا طول کلید هم لو نرود
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();

  return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, payload, extra = {}) {
  if (res.writableEnded) return;

  const body = JSON.stringify(payload);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  });

  res.end(body);
}

function log(kind, req, status, detail) {
  const url = req.url || '';
  const target = url.length > 200 ? url.slice(0, 200) + '…' : url;
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      kind,
      method: req.method,
      status,
      path: target,
      detail,
    })
  );
}

// ============================================================
// STARTUP
// ============================================================

server.listen(PORT, '0.0.0.0', () => {
  const hosts = parseList(process.env.ALLOWED_HOSTS);
  console.log(
    `Farsanime proxy v3 listening on 0.0.0.0:${PORT} | hosts=${(hosts.length ? hosts : DEFAULT_ALLOWED_HOSTS).join(',')} | ip_allowlist=${ALLOWED_CLIENT_IPS.length ? ALLOWED_CLIENT_IPS.length + ' entry' : 'off'} | key=${PROXY_KEY ? 'set' : 'MISSING'}`
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
