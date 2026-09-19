import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Produces the ZIP the Chrome Web Store expects: the built extension, zipped at
// its root (manifest.json at the top level, not inside a folder).
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'release');

const { version } = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const outFile = join(outDir, `lale-extension-${version}.zip`);

mkdirSync(outDir, { recursive: true });
rmSync(outFile, { force: true });
// -r recurse, -q quiet, -X drop macOS resource forks the store rejects.
execFileSync('zip', ['-rqX', outFile, '.'], { cwd: dist, stdio: 'inherit' });

console.log(`Wrote ${outFile}`);
console.log('Upload at https://chrome.google.com/webstore/devconsole — set visibility to Unlisted for a pre-release.');
