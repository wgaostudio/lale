export interface OverleafEditorSnapshot {
  projectId: string | null;
  documentText: string;
  selectedText: string | null;
  url: string | null;
  capturedAt: string;
}

const REQUEST_TYPE = 'LALE_DOC_TEXT_REQUEST';
const REPLY_TYPE = 'LALE_DOC_TEXT_REPLY';
const DEFAULT_TIMEOUT_MS = 1000;

export function detectOverleafEditor(): boolean {
  return document.querySelector('.cm-editor') !== null;
}

export function detectOverleafProject(url = window.location.href): {
  projectId: string | null;
  url: string | null;
} {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/project\/([^/]+)/);
    return {
      projectId: match?.[1] ?? null,
      url: parsed.href,
    };
  } catch {
    return { projectId: null, url: null };
  }
}

export function injectOverleafMainWorldScript(resourcePath = 'main-world.js'): void {
  if (document.querySelector('script[data-lale-main-world]')) return;

  const script = document.createElement('script');
  script.dataset.laleMainWorld = 'true';
  script.src = chrome.runtime.getURL(resourcePath);
  document.head.appendChild(script);
}

export async function readOverleafDocumentText(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const listener = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.data?.type === REPLY_TYPE &&
        event.data?.nonce === nonce
      ) {
        window.removeEventListener('message', listener);
        if (timeout) clearTimeout(timeout);
        resolve(typeof event.data.text === 'string' ? event.data.text : null);
      }
    };

    window.addEventListener('message', listener);
    window.postMessage({ type: REQUEST_TYPE, nonce }, '*');

    timeout = setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(null);
    }, timeoutMs);
  });
}

export async function captureOverleafSnapshot(): Promise<OverleafEditorSnapshot | null> {
  const documentText = await readOverleafDocumentText();
  if (documentText == null) return null;

  const selection = window.getSelection()?.toString();
  const project = detectOverleafProject();

  return {
    projectId: project.projectId,
    documentText,
    selectedText: selection && selection.length > 0 ? selection : null,
    url: project.url,
    capturedAt: new Date().toISOString(),
  };
}
