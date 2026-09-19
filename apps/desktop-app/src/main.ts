import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@lale/desktop/logging';

// ---------------------------------------------------------------------------
// macOS menu-bar shell.
//
// The service runs as a child process rather than inside this one. Electron's
// main process cannot load the service's native modules (better-sqlite3, keytar)
// without crashing on `node_module_register`, and separating them is better
// regardless: a fault in the service leaves the menu bar alive to report it.
//
// The shell supplies the two things a packaged app must and a terminal used to:
// somewhere to see the connection token, and someone to ask when an extension
// wants to pair.
// ---------------------------------------------------------------------------

interface PairingRequest {
  requestId: string;
  origin: string;
  clientName: string;
}

let tray: Tray | null = null;
let service: ChildProcess | null = null;
let token: string | null = null;
let status = 'starting…';
const serviceLog = new Logger();
let logFile = serviceLog.filePath;

app.dock?.hide();

function buildMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `lale ${app.getVersion()} — ${status}`, enabled: false },
    { type: 'separator' },
    {
      // The fallback for a browser that cannot pair on its own; ordinary setup
      // never needs it.
      label: 'Copy connection token',
      enabled: token !== null,
      click: () => {
        if (!token) return;
        clipboard.writeText(token);
        new Notification({ title: 'lale', body: 'Connection token copied to the clipboard.' }).show();
      },
    },
    { label: 'Open log', click: () => { void shell.openPath(logFile); } },
    { label: 'Open data folder', click: () => { void shell.openPath(join(homedir(), '.lale')); } },
    { type: 'separator' },
    { label: 'Quit lale', click: () => app.quit() },
  ]));
  tray.setToolTip(`lale ${app.getVersion()} — ${status}`);
}

/**
 * Asks the person whether an extension may connect.
 *
 * The prompt is parented to a real window on purpose. A message box with no
 * parent, in an accessory app that owns no windows, resolves immediately with
 * the default button — which approved pairing requests nobody had seen. The
 * prompt is this design's only security boundary, so it must be shown, focused,
 * and answered.
 */
async function approvePairing(request: PairingRequest): Promise<'approved' | 'denied'> {
  const host = new BrowserWindow({
    width: 480,
    height: 220,
    show: false,
    title: 'lale',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  try {
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox(host, {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      message: 'Allow this extension to connect?',
      detail:
        `${request.clientName}\n${request.origin}\n\n`
        + 'It will be able to run Lean checks and spend credit with your model provider.',
    });
    return response === 0 ? 'approved' : 'denied';
  } finally {
    host.destroy();
  }
}

function startService(): void {
  // ELECTRON_RUN_AS_NODE turns the bundled Electron binary into a plain Node
  // runtime, so the child is an ordinary Node process — no Electron ABI, and no
  // separate Node install required on the machine.
  service = fork(join(__dirname, 'service.cjs'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LALE_VERSION: app.getVersion() },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  // Drain both pipes: run events use console output, and an unread pipe can
  // eventually stall the service. Keep those events in the packaged app's log.
  service.stdout?.on('data', (chunk: Buffer) => serviceLog.info(chunk.toString().trimEnd()));
  service.stderr?.on('data', (chunk: Buffer) => serviceLog.error(chunk.toString().trimEnd()));

  service.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const payload = message as Record<string, unknown>;

    if (payload['type'] === 'ready') {
      token = typeof payload['token'] === 'string' ? payload['token'] : null;
      if (typeof payload['logFile'] === 'string') logFile = payload['logFile'];
      status = `running on 127.0.0.1:${String(payload['port'] ?? 8765)}`;
      buildMenu();
      return;
    }

    if (payload['type'] === 'failed') {
      status = 'failed to start';
      buildMenu();
      dialog.showErrorBox('lale could not start', `${String(payload['error'])}\n\nSee ${logFile}`);
      return;
    }

    if (payload['type'] === 'pairing-request' && typeof payload['requestId'] === 'string') {
      void approvePairing({
        requestId: payload['requestId'],
        origin: String(payload['origin'] ?? 'unknown origin'),
        clientName: String(payload['clientName'] ?? 'unknown client'),
      }).then((decision) => {
        service?.send({ type: 'pairing-decision', requestId: payload['requestId'], decision });
      }).catch(() => {
        // An unshowable prompt is a denial: nobody agreed to anything.
        service?.send({ type: 'pairing-decision', requestId: payload['requestId'], decision: 'denied' });
      });
    }
  });

  service.on('exit', (code) => {
    // A port already in use exits 2; that is a message, not a crash.
    status = code === 2 ? 'port 8765 already in use' : `stopped (exit ${String(code)})`;
    token = null;
    buildMenu();
  });
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromNamedImage('NSImageNameStatusAvailable', [-1, 0, 1]);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  buildMenu();
  startService();
}).catch((error: unknown) => {
  dialog.showErrorBox('lale could not start', String(error));
});

// The service holds Lean subprocesses and a database; let it shut down cleanly.
app.on('before-quit', () => { service?.kill('SIGTERM'); });
app.on('window-all-closed', () => undefined);
