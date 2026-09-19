import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Logging
//
// A packaged app has no terminal, so the log has to land somewhere a person can
// be pointed at: ~/Library/Logs/lale/desktop.log on macOS. When a terminal is
// attached the lines also go to it, because that is where a developer is
// looking.
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function defaultLogDir(): string {
  if (process.env['LALE_LOG_DIR']) return process.env['LALE_LOG_DIR'];
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'lale');
  return join(homedir(), '.lale', 'logs');
}

export class Logger {
  private readonly file: string;
  private readonly echo: boolean;

  constructor(logDir = defaultLogDir(), echo = process.stdout.isTTY === true) {
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, 'desktop.log');
    this.echo = echo;
  }

  get filePath(): string {
    return this.file;
  }

  info(message: string): void {
    this.write('info', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private write(level: 'info' | 'error', message: string): void {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    // Errors go to stderr so a shell can separate them, and both streams get
    // the same timestamped line that lands in the file.
    if (this.echo) (level === 'error' ? process.stderr : process.stdout).write(line);
    try {
      this.rotateIfLarge();
      appendFileSync(this.file, line, 'utf8');
    } catch {
      // A log that cannot be written must not take the service down with it.
    }
  }

  /** One generation back is enough to debug a bad startup without unbounded growth. */
  private rotateIfLarge(): void {
    try {
      if (statSync(this.file).size < MAX_LOG_BYTES) return;
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // Missing file on first write, or an unwritable directory; either way,
      // appendFileSync below reports the real problem.
    }
  }
}
