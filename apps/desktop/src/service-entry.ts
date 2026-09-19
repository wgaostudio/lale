import { start } from './server.js';

// Entry point for the packaged app, which forks this file as a child process.
// A failure here has nowhere to surface on its own, so it goes to stderr (which
// the shell copies into the log) as well as over IPC.
start().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`lale service failed to start: ${message}\n`);
  process.send?.({ type: 'failed', error: message });
  process.exit(1);
});
