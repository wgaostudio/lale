import { useCallback, useEffect, useState } from 'react';
import type { BackgroundBroadcastMessage, ExtensionState } from '../shared/messages';
import { sendMessage } from './lib/messaging';
import { ClaimDetail } from './views/ClaimDetail';
import { ConnectView } from './views/ConnectView';
import { MainView } from './views/MainView';
import { SettingsView } from './views/SettingsView';

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');

  const loadState = useCallback(async () => {
    const result = await sendMessage({ type: 'sidepanel.getState' });
    if (result?.ok && result.response) {
      setState(result.response as ExtensionState);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  // The background worker pushes the whole state on every change, so the panel
  // never polls.
  useEffect(() => {
    const listener = (message: BackgroundBroadcastMessage) => {
      if (message.type === 'state.updated') setState(message.state);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const selectClaim = useCallback((claimId: string) => {
    setSelectedClaimId(claimId);
  }, []);

  if (!state) {
    return (
      <section className="empty">
        <h1>lale</h1>
        <p className="lale-muted">Loading extension state.</p>
      </section>
    );
  }

  // Force the connect view whenever we lack a usable token — nothing else in
  // the panel can do anything useful until one is stored.
  if (!state.hasBearerToken || state.desktopAuthStatus === 'unauthorized') {
    return (
      <ConnectView
        state={state}
        onRequestPairing={async () => {
          const result = await sendMessage({ type: 'sidepanel.requestPairing' });
          if (!result?.ok) throw new Error(result?.error ?? 'Could not reach the desktop app.');
          await loadState();
        }}
        onConnect={(token) => {
          void sendMessage({ type: 'sidepanel.setBearerToken', token }).then(loadState);
        }}
      />
    );
  }

  if (view === 'settings') {
    return (
      <SettingsView
        state={state}
        onClose={() => setView('main')}
        onClearToken={() => {
          void sendMessage({ type: 'sidepanel.clearBearerToken' }).then(loadState);
        }}
        onSaveKey={(key) => {
          void sendMessage({ type: 'sidepanel.setOpenRouterKey', key }).then(loadState);
        }}
        onClearKey={() => {
          void sendMessage({ type: 'sidepanel.clearOpenRouterKey' }).then(loadState);
        }}
        onStartProvision={() => {
          // Always force on a user-initiated click: a half-built `.lake/` from a
          // prior failed attempt makes the desktop see the project as "ready"
          // and short-circuit without a force flag.
          void sendMessage({ type: 'sidepanel.startProvision', force: true }).then(loadState);
        }}
      />
    );
  }

  const selected =
    selectedClaimId != null
      ? (state.parsedDocument?.claims.find((claim) => claim.id === selectedClaimId) ?? null)
      : null;

  if (selected) {
    return (
      <ClaimDetail
        claim={selected}
        state={state}
        onBack={() => setSelectedClaimId(null)}
        onSelect={selectClaim}
        onVerify={(claimId, mode) => {
          void sendMessage({ type: 'sidepanel.verifyClaim', claimId, mode }).then(loadState);
        }}
        onJumpToSource={(claimId) => {
          void sendMessage({ type: 'sidepanel.jumpToSource', claimId });
        }}
        onAcknowledge={(runId, reason) => {
          void sendMessage({
            type: 'sidepanel.acknowledgeInformalAudit',
            runId,
            reason,
          }).then(loadState);
        }}
      />
    );
  }

  return (
    <MainView
      state={state}
      selectedClaimId={selectedClaimId}
      onSelect={selectClaim}
      onRefresh={() => void loadState()}
      onOpenSettings={() => setView('settings')}
      onCreateProject={() => {
        void sendMessage({ type: 'sidepanel.createProject' }).then(loadState);
      }}
    />
  );
}
