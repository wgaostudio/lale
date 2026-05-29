import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheStatus = 'ok' | 'failed' | 'timeout';

export interface CacheKey {
  normalizedGoalTerm: string;
  environmentFingerprint: string;
  leanVersion: string;
  mathlibRevision: string;
}

export interface CacheValue {
  status: CacheStatus;
  provenByJson: string | null;
  diagnosticsJson: string;
  elapsedMs: number;
}

export interface CacheHit extends CacheValue {
  cacheKey: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export function deriveCacheKey(input: CacheKey): string {
  const h = createHash('sha256');
  h.update(input.normalizedGoalTerm);
  h.update('\x00');
  h.update(input.environmentFingerprint);
  h.update('\x00');
  h.update(input.leanVersion);
  h.update('\x00');
  h.update(input.mathlibRevision);
  return h.digest('hex');
}

export function hashGoalTerm(term: string): string {
  return createHash('sha256').update(term).digest('hex');
}

export function hashEnvironmentFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

// ---------------------------------------------------------------------------
// Cache — operates on the caller-provided DB connection
// ---------------------------------------------------------------------------

const FAILURE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class LeanCheckCache {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  lookup(key: CacheKey): CacheHit | null {
    const cacheKey = deriveCacheKey(key);
    const row = this.db
      .prepare(
        `SELECT status, provenByJson, diagnosticsJson, elapsedMs, createdAt, ttlExpiresAt
         FROM lean_check_cache
         WHERE cacheKey = ?`,
      )
      .get(cacheKey) as
      | {
          status: CacheStatus;
          provenByJson: string | null;
          diagnosticsJson: string;
          elapsedMs: number;
          createdAt: string;
          ttlExpiresAt: string | null;
        }
      | undefined;

    if (!row) return null;

    // Expire failed/timeout entries after TTL.
    if (row.ttlExpiresAt && new Date(row.ttlExpiresAt) < new Date()) {
      this.db.prepare('DELETE FROM lean_check_cache WHERE cacheKey = ?').run(cacheKey);
      return null;
    }

    this.db
      .prepare('UPDATE lean_check_cache SET lastUsedAt = ? WHERE cacheKey = ?')
      .run(new Date().toISOString(), cacheKey);

    return { ...row, cacheKey };
  }

  store(key: CacheKey, value: CacheValue): string {
    const cacheKey = deriveCacheKey(key);
    const now = new Date().toISOString();
    const ttlExpiresAt =
      value.status !== 'ok' ? new Date(Date.now() + FAILURE_TTL_MS).toISOString() : null;

    this.db
      .prepare(
        `INSERT INTO lean_check_cache
           (cacheKey, normalizedGoalHash, environmentFingerprintHash, leanVersion, mathlibRevision,
            status, provenByJson, diagnosticsJson, elapsedMs, createdAt, lastUsedAt, ttlExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cacheKey) DO UPDATE SET
           status = excluded.status,
           provenByJson = excluded.provenByJson,
           diagnosticsJson = excluded.diagnosticsJson,
           elapsedMs = excluded.elapsedMs,
           lastUsedAt = excluded.lastUsedAt,
           ttlExpiresAt = excluded.ttlExpiresAt`,
      )
      .run(
        cacheKey,
        hashGoalTerm(key.normalizedGoalTerm),
        hashEnvironmentFingerprint(key.environmentFingerprint),
        key.leanVersion,
        key.mathlibRevision,
        value.status,
        value.provenByJson,
        value.diagnosticsJson,
        value.elapsedMs,
        now,
        now,
        ttlExpiresAt,
      );

    return cacheKey;
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM lean_check_cache')
      .get() as { n: number };
    return row.n;
  }
}
