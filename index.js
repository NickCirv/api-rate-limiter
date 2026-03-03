#!/usr/bin/env node
// api-rate-limiter — zero-dependency HTTP proxy with configurable rate limiting
// Usage: api-rate-limiter start --port 3001 --target http://localhost:3000 --limit 10/min

import http from 'http';
import https from 'https';
import { createServer } from 'net';
import { URL } from 'url';
import { createHash, randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const STATS_SOCKET_PATH = '/tmp/api-rate-limiter.sock';
const STATS_FILE = '/tmp/api-rate-limiter-stats.json';

// ─── Argument Parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
    i++;
  }
  return args;
}

// ─── Config Loader ────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  const p = resolve(process.cwd(), configPath);
  if (!existsSync(p)) {
    console.error(`Config file not found: ${p}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse config: ${e.message}`);
    process.exit(1);
  }
}

// ─── Rate Limit Parser ────────────────────────────────────────────────────────

function parseLimit(limitStr) {
  if (!limitStr) return { count: 60, windowMs: 60_000 };
  const m = String(limitStr).match(/^(\d+)\/(s|sec|min|hour|hr)$/i);
  if (!m) {
    console.error(`Invalid limit format: "${limitStr}". Use e.g. 10/min, 100/hour, 5/s`);
    process.exit(1);
  }
  const count = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const windowMs = unit === 's' || unit === 'sec' ? 1_000
    : unit === 'min' ? 60_000
    : 3_600_000;
  return { count, windowMs };
}

function parseDelay(delayStr) {
  if (!delayStr || delayStr === false) return 0;
  const m = String(delayStr).match(/^(\d+)(ms|s)?$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return (m[2] || '').toLowerCase() === 's' ? n * 1000 : n;
}

// ─── Rate Limiter Core ────────────────────────────────────────────────────────

class RateLimiter {
  constructor(opts) {
    this.limit = opts.limit;          // max requests per window
    this.windowMs = opts.windowMs;    // window size in ms
    this.burst = opts.burst || 0;     // burst allowance on top of limit
    this.perIp = opts.perIp || false;
    this.perPath = opts.perPath || false;
    // Map: key → { currentBucket: count, prevBucket: count, windowStart: ts }
    this.buckets = new Map();
    this.totalRequests = 0;
    this.totalRejected = 0;
    this.pathCounts = new Map();
    this.windowRequests = 0;
    this.windowStart = Date.now();
    // GC timer
    setInterval(() => this._gc(), this.windowMs * 2).unref();
  }

  _key(ip, path) {
    const parts = [];
    if (this.perIp) parts.push(ip);
    if (this.perPath) parts.push(path);
    return parts.length ? parts.join(':') : '__global__';
  }

  _gc() {
    const now = Date.now();
    for (const [k, v] of this.buckets) {
      if (now - v.windowStart > this.windowMs * 3) {
        this.buckets.delete(k);
      }
    }
  }

  // Sliding window approximation via two buckets
  check(ip, path) {
    const key = this._key(ip, path);
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { currentCount: 0, prevCount: 0, windowStart: now };
      this.buckets.set(key, bucket);
    }

    // If current window expired, rotate buckets
    if (now - bucket.windowStart >= this.windowMs) {
      bucket.prevCount = bucket.currentCount;
      bucket.currentCount = 0;
      bucket.windowStart = now;
    }

    // Sliding window approximation
    const elapsed = now - bucket.windowStart;
    const weight = 1 - elapsed / this.windowMs;
    const estimated = Math.floor(bucket.prevCount * weight) + bucket.currentCount;

    const maxAllowed = this.limit + (this.burst || 0);

    this.totalRequests++;
    this.pathCounts.set(path, (this.pathCounts.get(path) || 0) + 1);

    // Track per-window request rate
    if (now - this.windowStart >= this.windowMs) {
      this.windowRequests = 0;
      this.windowStart = now;
    }
    this.windowRequests++;

    if (estimated >= maxAllowed) {
      this.totalRejected++;
      const retryAfter = Math.ceil((this.windowMs - elapsed) / 1000);
      return { allowed: false, retryAfter };
    }

    bucket.currentCount++;
    return { allowed: true };
  }

  stats() {
    const topPaths = [...this.pathCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return {
      totalRequests: this.totalRequests,
      totalRejected: this.totalRejected,
      windowRequests: this.windowRequests,
      topPaths,
      bucketCount: this.buckets.size,
    };
  }
}

// ─── Proxy Request ────────────────────────────────────────────────────────────

function proxyRequest(req, res, target, delay, errorRate) {
  return new Promise((resolve) => {
    // Chaos: random 500
    if (errorRate > 0 && Math.random() * 100 < errorRate) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Chaos error injected by api-rate-limiter' }));
      return resolve();
    }

    const doProxy = () => {
      let targetUrl;
      try {
        targetUrl = new URL(req.url, target);
      } catch {
        res.writeHead(502);
        res.end('Bad target URL');
        return resolve();
      }

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + (targetUrl.search || ''),
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
        proxyRes.on('error', resolve);
      });

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream connection failed', detail: err.message }));
        }
        resolve();
      });

      req.pipe(proxyReq);
    };

    if (delay > 0) {
      setTimeout(doProxy, delay);
    } else {
      doProxy();
    }
  });
}

// ─── Stats Display ────────────────────────────────────────────────────────────

let lastLineCount = 0;

function renderStats(limiter, config) {
  const s = limiter.stats();
  const lines = [
    '',
    `  api-rate-limiter v${VERSION}`,
    `  ──────────────────────────────────────────`,
    `  Proxy:   ${config.port} → ${config.target}`,
    `  Limit:   ${config.limit} (window: ${config.windowMs}ms)${config.burst ? ` | burst: +${config.burst}` : ''}`,
    `  Mode:    ${config.perIp ? 'per-IP' : config.perPath ? 'per-path' : 'global'}${config.delay ? ` | delay: ${config.delay}ms` : ''}${config.errorRate ? ` | chaos: ${config.errorRate}%` : ''}`,
    `  ──────────────────────────────────────────`,
    `  Total:   ${s.totalRequests} requests | ${s.totalRejected} rejected (${s.totalRequests ? Math.round(s.totalRejected / s.totalRequests * 100) : 0}%)`,
    `  Window:  ${s.windowRequests} req in current window`,
    `  Buckets: ${s.bucketCount} active keys`,
    `  Top paths:`,
    ...s.topPaths.map(([p, c]) => `    ${c.toString().padStart(4)}  ${p}`),
    '',
    `  Press Ctrl+C to stop`,
    '',
  ];

  // Move cursor up and clear
  if (lastLineCount > 0) {
    process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
  }

  process.stdout.write(lines.join('\n'));
  lastLineCount = lines.length;
}

// ─── Stats Command ────────────────────────────────────────────────────────────

function runStatsCommand() {
  if (!existsSync(STATS_FILE)) {
    console.log('No running api-rate-limiter found. Start one with: api-rate-limiter start ...');
    process.exit(0);
  }
  try {
    const data = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    console.log('\n  api-rate-limiter stats');
    console.log('  ──────────────────────────────────────────');
    console.log(`  Target:   ${data.target}`);
    console.log(`  Port:     ${data.port}`);
    console.log(`  Limit:    ${data.limitStr}`);
    console.log(`  Uptime:   ${Math.floor((Date.now() - data.startedAt) / 1000)}s`);
    console.log(`  Total:    ${data.totalRequests} requests`);
    console.log(`  Rejected: ${data.totalRejected}`);
    console.log(`  Window:   ${data.windowRequests} req in current window`);
    if (data.topPaths && data.topPaths.length) {
      console.log('  Top paths:');
      for (const [p, c] of data.topPaths) {
        console.log(`    ${String(c).padStart(4)}  ${p}`);
      }
    }
    console.log('');
  } catch {
    console.log('Could not read stats file.');
  }
}

// ─── Start Command ────────────────────────────────────────────────────────────

function runStart(rawConfig) {
  const { count: limitCount, windowMs } = parseLimit(rawConfig.limit);
  const delay = parseDelay(rawConfig.delay);
  const errorRate = rawConfig['error-rate'] ? parseFloat(rawConfig['error-rate']) : 0;
  const burst = rawConfig.burst ? parseInt(rawConfig.burst, 10) : 0;
  const port = parseInt(rawConfig.port || 3001, 10);
  const target = rawConfig.target || 'http://localhost:3000';
  const perIp = rawConfig['per-ip'] === true || rawConfig['per-ip'] === 'true';
  const perPath = rawConfig['per-path'] === true || rawConfig['per-path'] === 'true';

  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    console.error('Target must be a full URL (http:// or https://)');
    process.exit(1);
  }

  const limiter = new RateLimiter({ limit: limitCount, windowMs, burst, perIp, perPath });

  const config = {
    port, target, limit: rawConfig.limit || '60/min', windowMs, burst, delay, errorRate, perIp, perPath,
  };

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || '0.0.0.0';
    const path = (new URL(req.url, `http://localhost`)).pathname;

    const result = limiter.check(ip, path);

    if (!result.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter || 1),
        'X-RateLimit-Limit': String(limitCount),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + (result.retryAfter || 1)),
      });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Retry after ${result.retryAfter}s`,
        retryAfter: result.retryAfter,
      }));
      return;
    }

    await proxyRequest(req, res, target, delay, errorRate);
  });

  server.listen(port, () => {
    console.clear();
    console.log(`\n  api-rate-limiter started on :${port} → ${target}\n`);
    renderStats(limiter, config);
  });

  // Periodically write stats file and refresh display
  const startedAt = Date.now();
  const statsInterval = setInterval(() => {
    const s = limiter.stats();
    const statsData = {
      target,
      port,
      limitStr: rawConfig.limit || '60/min',
      startedAt,
      ...s,
      topPaths: s.topPaths,
    };
    try {
      import('fs').then(({ writeFileSync }) => {
        writeFileSync(STATS_FILE, JSON.stringify(statsData), 'utf8');
      });
    } catch { /* ignore */ }
    renderStats(limiter, config);
  }, 1000);

  server.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    clearInterval(statsInterval);
    server.close(() => {
      try {
        import('fs').then(({ unlinkSync, existsSync: ex }) => {
          if (ex(STATS_FILE)) unlinkSync(STATS_FILE);
        });
      } catch { /* ignore */ }
      process.stdout.write('\n\n  Stopped.\n\n');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  api-rate-limiter v${VERSION} — zero-dependency HTTP proxy with rate limiting

  COMMANDS
    start    Start the rate-limiting proxy
    stats    Show live stats from a running proxy

  START OPTIONS
    --port <n>          Proxy listen port (default: 3001)
    --target <url>      Upstream URL to proxy to (default: http://localhost:3000)
    --limit <rate>      Rate limit: 10/s | 60/min | 1000/hour (default: 60/min)
    --per-ip            Apply limit per client IP (default: global)
    --per-path          Apply limit per URL path (default: global)
    --burst <n>         Allow burst of N extra requests per window
    --delay <ms>        Add artificial delay to all requests (e.g. 500ms, 2s)
    --error-rate <pct>  Randomly fail N% of requests with 500 (chaos mode)
    --config <file>     Load options from JSON config file

  EXAMPLES
    api-rate-limiter start --port 3001 --target http://localhost:3000 --limit 10/min
    api-rate-limiter start --target https://api.example.com --limit 100/hour --per-ip
    api-rate-limiter start --target http://localhost:8080 --limit 5/s --burst 10
    api-rate-limiter start --target http://localhost:3000 --delay 300ms --error-rate 10
    api-rate-limiter start --config rl.json
    api-rate-limiter stats

  CONFIG FILE (rl.json)
    {
      "port": 3001,
      "target": "http://localhost:3000",
      "limit": "10/min",
      "perIp": true,
      "burst": 5,
      "delay": "200ms",
      "errorRate": 5
    }

  ALIAS
    rl start ...   (same as api-rate-limiter start ...)
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const command = args._[0];

if (!command || args.help || args.h) {
  if (!command) showHelp();
  else showHelp();
  process.exit(0);
}

if (args.version || args.v) {
  console.log(`api-rate-limiter v${VERSION}`);
  process.exit(0);
}

if (command === 'stats') {
  runStatsCommand();
} else if (command === 'start') {
  let config = { ...args };
  delete config._;

  if (args.config) {
    const fileConfig = loadConfig(args.config);
    // CLI args override file config, normalise perIp/per-ip etc.
    const normalised = {
      port: fileConfig.port,
      target: fileConfig.target,
      limit: fileConfig.limit,
      burst: fileConfig.burst,
      delay: fileConfig.delay,
      'error-rate': fileConfig.errorRate,
      'per-ip': fileConfig.perIp,
      'per-path': fileConfig.perPath,
    };
    config = { ...normalised, ...config };
  }

  runStart(config);
} else {
  console.error(`Unknown command: "${command}". Run api-rate-limiter --help`);
  process.exit(1);
}
