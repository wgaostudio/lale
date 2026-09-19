import { useState } from 'react';
import { Button, Panel, Section, Status, Textarea } from '@lale/ui';
import type { ExtensionState } from '../../shared/messages';
import { TopBar } from '../components/TopBar';

export function ConnectView({
  state,
  onRequestPairing,
  onConnect,
}: {
  state: ExtensionState;
  onRequestPairing: () => Promise<void>;
  onConnect: (token: string) => void;
}) {
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  // Pasting a token is the fallback for a desktop with no window to approve in
  // — a headless or remote one. It stays out of the way until asked for.
  const [showManual, setShowManual] = useState(false);
  const isUnauthorized = state.hasBearerToken && state.desktopAuthStatus === 'unauthorized';
  const desktopReachable = state.desktopStatus === 'connected';

  return (
    <>
      <TopBar title="lale" subtitle="not connected" />
      <Section label="Connect to the desktop app">
        <p>
          Connecting asks the lale desktop app for permission. Approve the prompt it shows and
          this panel takes it from there — there is nothing to copy across.
        </p>
        <div className="actions">
          <Button
            variant="primary"
            disabled={pairing || !desktopReachable}
            onClick={() => {
              setPairing(true);
              setPairingError(null);
              void onRequestPairing()
                .catch((error: unknown) => setPairingError(error instanceof Error ? error.message : String(error)))
                .finally(() => setPairing(false));
            }}
          >
            {pairing ? 'Waiting for approval…' : 'Connect'}
          </Button>
        </div>
        <div className="status-strip">
          <Status tone={desktopReachable ? 'ok' : 'warn'}>
            Desktop {desktopReachable ? 'reachable' : state.desktopStatus}
          </Status>
          {isUnauthorized && <Status tone="bad">Connection rejected</Status>}
        </div>
        {pairingError && (
          <Panel>
            <p className="lale-muted">{pairingError}</p>
          </Panel>
        )}
        {state.error && !desktopReachable && (
          <Panel>
            <p className="lale-muted">{state.error}</p>
          </Panel>
        )}
        {showManual ? (
          <>
            <p className="lale-muted">
              Choose “Copy connection token” from the lale menu-bar app, then paste it here.
            </p>
            <Textarea
              mono
              rows={3}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste connection token"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              aria-label="Connection token"
            />
            <div className="actions">
              <Button
                variant="quiet"
                disabled={token.trim().length === 0}
                onClick={() => onConnect(token.trim())}
              >
                Use this token
              </Button>
            </div>
          </>
        ) : (
          <div className="actions">
            <Button variant="quiet" onClick={() => setShowManual(true)}>
              Enter a token manually
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
