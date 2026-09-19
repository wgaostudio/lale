import { createHash } from 'node:crypto';

/** Content hash for stored artifacts and cache keys. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
