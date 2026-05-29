import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

// Accept requests from the extension and from Overleaf origins.
// The extension's chrome-extension:// origin is included; Overleaf domains cover
// the standard and self-hosted variants.
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^https?:\/\/(?:www\.)?overleaf\.com$/,
  /^https?:\/\/[a-zA-Z0-9.-]+\.overleaf\.com$/,
];

// Also allow no-origin requests from localhost tooling (curl, tests).
const LOCALHOST_ORIGINS = new Set(['http://127.0.0.1:8765', 'http://localhost:8765', '']);

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin || LOCALHOST_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

// ---------------------------------------------------------------------------
// Bearer token
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'bearerToken';

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

export function checkAuth(
  request: IncomingMessage,
  token: string,
): AuthResult {
  const origin = request.headers['origin'];

  if (!isOriginAllowed(origin)) {
    return { ok: false, reason: `Origin not allowed: ${origin}` };
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  // Health endpoint is public (extension needs to probe without a token yet).
  if (url.pathname === '/v1/health') return { ok: true };

  const authHeader = request.headers['authorization'];
  const queryToken = url.searchParams.get('token');
  if ((!authHeader || !authHeader.startsWith('Bearer ')) && !queryToken) {
    return { ok: false, reason: 'Missing Authorization header' };
  }

  const provided = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : queryToken;
  if (provided !== token) {
    return { ok: false, reason: 'Invalid bearer token' };
  }

  return { ok: true };
}

export function sendUnauthorized(response: ServerResponse, reason: string): void {
  response.writeHead(401, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: reason }));
}

export function sendForbidden(response: ServerResponse, reason: string): void {
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: reason }));
}
