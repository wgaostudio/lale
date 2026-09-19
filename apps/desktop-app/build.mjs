import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Native modules stay outside the bundle: they ship prebuilt `.node` binaries
// that esbuild cannot inline. electron-builder includes them beside the bundle.
const external = ['electron', 'better-sqlite3', 'keytar'];

// The service is bundled as CommonJS for the shell's Node child process;
// its imports (workspace packages, the OpenAI SDK) are pulled in.
await build({
  entryPoints: [join(here, '..', 'desktop', 'src', 'service-entry.ts')],
  outfile: join(here, 'dist', 'service.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external,
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  outfile: join(here, 'dist', 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external,
  sourcemap: true,
  logLevel: 'info',
});
