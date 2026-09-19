import { defineManifest } from '@crxjs/vite-plugin';
// One version for the extension. `pack:store` names the ZIP from the built
// manifest, so a manifest version written by hand here could ship under a
// number the package never had.
import { version } from './package.json';

const icons = {
  16: 'brand/icon-16.png',
  32: 'brand/icon-32.png',
  48: 'brand/icon-48.png',
  128: 'brand/icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'lale',
  version,
  description: 'Local-first Lean verification for Overleaf.',
  icons,
  permissions: ['sidePanel', 'storage', 'tabs', 'alarms'],
  host_permissions: ['https://*.overleaf.com/*', 'http://127.0.0.1:8765/*'],
  action: {
    default_title: 'lale',
    default_icon: icons,
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://*.overleaf.com/project/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  web_accessible_resources: [
    {
      resources: ['main-world.js'],
      matches: ['https://*.overleaf.com/*'],
    },
  ],
});
