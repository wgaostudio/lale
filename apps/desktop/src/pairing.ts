import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pairing
//
// The desktop holds a bearer token the extension must present. Making the user
// carry it across by hand was tolerable when the service ran in a terminal; a
// packaged app has no terminal to print it to, and a 64-character paste was the
// worst step of setup regardless.
//
// Instead the extension asks to pair and the person approves once, in the app.
// Approval is what proves the request came from them rather than from another
// extension or a local process — an Origin header proves nothing here, since
// anything on the machine can set one.
// ---------------------------------------------------------------------------

export interface PairingRequest {
  requestId: string;
  /** Origin of the asking client, e.g. chrome-extension://<id>. */
  origin: string;
  /** What the client calls itself. Display only; never trusted. */
  clientName: string;
  requestedAt: string;
}

export type PairingDecision = 'approved' | 'denied';

/** Asks the person. Returns their decision. */
export type PairingApprover = (request: PairingRequest) => Promise<PairingDecision>;

export class PairingAlreadyPendingError extends Error {}

export class PairingBroker {
  private approver: PairingApprover | null = null;
  private pending: PairingRequest | null = null;

  /**
   * Registered by the app shell at startup. Without one there is nobody to ask,
   * so requests are refused rather than waved through — except in a terminal,
   * where `approveFromTerminal` stands in.
   */
  setApprover(approver: PairingApprover | null): void {
    this.approver = approver;
  }

  get hasApprover(): boolean {
    return this.approver !== null;
  }

  get pendingRequest(): PairingRequest | null {
    return this.pending;
  }

  async request(origin: string, clientName: string): Promise<PairingDecision> {
    if (this.pending) throw new PairingAlreadyPendingError('Another pairing request is already waiting');
    if (!this.approver) return 'denied';

    const request: PairingRequest = {
      requestId: randomUUID(),
      origin,
      clientName,
      requestedAt: new Date().toISOString(),
    };
    this.pending = request;
    try {
      return await this.approver(request);
    } finally {
      this.pending = null;
    }
  }
}

/**
 * Stand-in approver for `pnpm desktop:dev`, where the person is already at the
 * terminal that started it and no window exists to prompt in. Approves, and says so
 * loudly — a packaged build always registers a real approver instead.
 */
export function approveFromTerminal(log: (message: string) => void): PairingApprover {
  return async (request) => {
    log(`Pairing request from ${request.origin} (${request.clientName}) — approved automatically (development mode)`);
    return 'approved';
  };
}
