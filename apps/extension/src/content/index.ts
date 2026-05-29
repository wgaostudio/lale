import {
  captureOverleafSnapshot,
  detectOverleafEditor,
  detectOverleafProject,
  injectOverleafMainWorldScript,
} from '@lale/overleaf-adapter';
import { parseLatexDocument } from '@lale/document-parser';
import type { OverleafDocumentSnapshot } from '@lale/protocol';
import type { BackgroundToContentMessage, ContentToBackgroundMessage } from '../shared/messages';

const DEBOUNCE_MS = 1500;

let timer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let lastDocumentFingerprint: string | null = null;

injectOverleafMainWorldScript();
sendProjectDetected();

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
  if (message.type === 'content.jumpToSource') {
    window.postMessage({ type: 'LALE_SCROLL_TO_OFFSET_REQUEST', offset: message.startOffset }, '*');
  }
});

function scheduleCapture(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void captureAndSend();
  }, DEBOUNCE_MS);
}

async function captureAndSend(): Promise<void> {
  const snapshot = await captureOverleafSnapshot();
  if (!snapshot) {
    sendMessage({ type: 'content.captureFailed', reason: 'Overleaf editor text was unavailable.' });
    return;
  }

  const parsedDocument = parseLatexDocument(snapshot.documentText);
  if (parsedDocument.fingerprint === lastDocumentFingerprint) return;
  lastDocumentFingerprint = parsedDocument.fingerprint;

  const message: OverleafDocumentSnapshot = {
    source: 'overleaf',
    projectId: snapshot.projectId,
    documentText: snapshot.documentText,
    selectedText: snapshot.selectedText,
    url: snapshot.url,
    capturedAt: snapshot.capturedAt,
  };

  sendMessage({ type: 'content.snapshotCaptured', snapshot: message, parsedDocument });
}

function attachObserver(): void {
  if (observer) return;

  const editor = document.querySelector('.cm-editor');
  if (!editor) {
    setTimeout(attachObserver, 1000);
    return;
  }

  observer = new MutationObserver(scheduleCapture);
  observer.observe(editor, { childList: true, subtree: true, characterData: true });
  void captureAndSend();
}

if (detectOverleafEditor()) {
  attachObserver();
} else {
  setTimeout(attachObserver, 1000);
}

function sendProjectDetected(): void {
  const project = detectOverleafProject();
  sendMessage({
    type: 'content.projectDetected',
    project: {
      source: 'overleaf',
      projectId: project.projectId,
      url: project.url,
      detectedAt: new Date().toISOString(),
    },
  });
}

function sendMessage(message: ContentToBackgroundMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // MV3 service workers may be asleep; subsequent captures will retry.
  });
}
