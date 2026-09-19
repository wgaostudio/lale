import { start } from './server.js';

// Terminal entry point. The packaged app calls `start()` itself, after
// registering the approver that a person clicks.
await start();
