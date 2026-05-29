import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'lale',
  version: '0.1.0',
  description: 'Local-first Lean verification for Overleaf.',
  permissions: ['sidePanel', 'storage', 'tabs'],
  host_permissions: ['https://www.overleaf.com/*', 'http://127.0.0.1:8765/*'],
  action: {
    default_title: 'lale',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://www.overleaf.com/project/*'],
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
      matches: ['https://www.overleaf.com/*'],
    },
  ],
});

