import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

// Overleaf domains cover the standard and self-hosted variants.
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https?:\/\/(?:www\.)?overleaf\.com$/,
  /^https?:\/\/[a-zA-Z0-9.-]+\.overleaf\.com$/,
];

/**
 * The one place the service's port is written down. The extension cannot follow
 * an override — its manifest `host_permissions` and panel base URL are fixed at
 * build time — so this is the address the whole system means by "the service".
 */
export const DEFAULT_PORT = 8765;

// Also allow no-origin requests from localhost tooling (curl, tests). This is
// not a security boundary: any local process can omit an Origin header or forge
// one, so the bearer token is what actually guards the API. The origin check
// only stops a web page a browser refuses to lie for.
function localhostOrigins(port: number): ReadonlySet<string> {
  return new Set(['', `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

let allowedLocalhostOrigins = localhostOrigins(DEFAULT_PORT);

/** Points the localhost allowlist at the port the server actually bound. */
export function setServicePort(port: number): void {
  allowedLocalhostOrigins = localhostOrigins(port);
}

const EXTENSION_ORIGIN = /^(?:chrome|moz)-extension:\/\/[a-z0-9]+\/?$/i;

/**
 * Extension origins are accepted only once one has paired: the first approved
 * pairing records its origin, and others are refused from then on. Before that,
 * any extension may reach `/v1/pair`, where a person decides.
 */
export function isOriginAllowed(origin: string | undefined, pairedOrigins: ReadonlySet<string> = new Set()): boolean {
  if (!origin || allowedLocalhostOrigins.has(origin)) return true;
  if (EXTENSION_ORIGIN.test(origin)) return pairedOrigins.has(normalizeOrigin(origin));
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Bearer token
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'bearerToken';
const PAIRED_ORIGINS_KEY = 'pairedOrigins';

export function getOrCreateToken(db: Database): string {
  const row = db
    .prepare('SELECT value FROM install_config WHERE key = ?')
    .get(TOKEN_KEY) as { value: string } | undefined;

  if (row) return row.value;

  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO install_config (key, value) VALUES (?, ?)').run(TOKEN_KEY, token);
  return token;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

/** Origins that have completed an approved pairing. */
export function readPairedOrigins(db: Database): Set<string> {
  const row = db
    .prepare('SELECT value FROM install_config WHERE key = ?')
    .get(PAIRED_ORIGINS_KEY) as { value: string } | undefined;
  if (!row) return new Set();
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

export function recordPairedOrigin(db: Database, origin: string): Set<string> {
  const origins = readPairedOrigins(db);
  origins.add(normalizeOrigin(origin));
  db.prepare(
    `INSERT INTO install_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PAIRED_ORIGINS_KEY, JSON.stringify([...origins]));
  return origins;
}

export function checkAuth(
  request: IncomingMessage,
  token: string,
  pairedOrigins: ReadonlySet<string> = new Set(),
): AuthResult {
  const origin = request.headers['origin'];
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  // Public endpoints: probing for the service, and asking to pair with it.
  // Pairing is deliberately reachable before an origin is known — that request
  // is decided by a person, not by a header.
  if (url.pathname === '/v1/health' || url.pathname === '/v1/pair') return { ok: true };

  if (!isOriginAllowed(origin, pairedOrigins)) {
    return { ok: false, reason: `Origin not allowed: ${origin}` };
  }

  // Header only: a token in a query string ends up in any log that records URLs.
  const authHeader = request.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, reason: 'Missing Authorization header' };
  }

  if (!tokensMatch(authHeader.slice(7).trim(), token)) {
    return { ok: false, reason: 'Invalid bearer token' };
  }

  return { ok: true };
}

/**
 * Compared in constant time. `!==` returns at the first differing byte, which
 * leaks a prefix-guessing oracle to anything that can time the response. The
 * token's length is fixed and public, so comparing lengths first gives nothing
 * away.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sendUnauthorized(response: ServerResponse, reason: string): void {
  response.writeHead(401, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: reason }));
}

export function sendForbidden(response: ServerResponse, reason: string): void {
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: reason }));
}
