import type { SidepanelToBackgroundMessage } from '../../shared/messages';

export interface MessageResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export async function sendMessage(message: SidepanelToBackgroundMessage): Promise<MessageResult> {
  return chrome.runtime.sendMessage(message);
}
