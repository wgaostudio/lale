# Extension Flow

## First Run

1. Extension boots and probes the desktop service.
2. If no bearer token is stored (or the stored token is rejected), the side
   panel renders a **Connect** view that asks the user to paste the token the
   desktop service printed to its terminal on first run. Saving the token
   writes it to `chrome.storage.local["lale.bearerToken"]` and triggers a
   re-probe.
3. Once authorized, the panel checks `GET /v1/provision`. If
   `projectReady === false`, a "Lean toolchain not installed" callout is shown
   above the main view; opening Settings reveals an Install Lean + Mathlib
   button that triggers `POST /v1/provision` and streams progress.
4. Extension detects an Overleaf project URL.
5. Content script reads the current CodeMirror document through the main-world
   adapter.
6. Document parser extracts claims, adjacent proofs, labels, explicit
   references, document issues, and a dependency graph.
7. Background asks the desktop app whether this Overleaf project is already
   linked to a lale project.
8. If not linked, the side panel shows a Create Project action.

## Settings

A `⚙` icon in the topbar opens a Settings drawer that always contains two
sections:

- **Desktop connection** — current auth status pill (Authorized / Unverified)
  and a "Clear token" button that wipes the stored bearer token and returns
  the panel to the Connect view.
- **Lean + Mathlib** — current `leanVersion`, `mathlibRevision`, and
  provisioning status (idle / running / ready / failed). When idle or
  failed, an Install / Reprovision button kicks off `POST /v1/provision`. When
  running, the most recent provisioning log lines are shown in a scrolling
  `<pre>` block updated live from SSE.

## Main View

- Project header: Overleaf project ID, desktop status, project link status.
- Readiness/issues panel: missing packages, unlabeled claims, unresolved refs,
  missing proofs, cycles.
- Dependency graph: explicit references only, no LLM fallback.
- Claim list: environment type, label, proof status, dependency count, status,
  source jump.

## Claim Detail

- Statement and adjacent proof.
- Upstream dependencies and their statuses.
- Downstream dependents.
- Verify action.
- Informal advisory panel — see below.
- Mark as non-mathematical edit action when stale support is wired in.

## Informal Advisory Panel

When a verification is running for the visible claim, the claim detail view
renders a dedicated panel for the §3.5 informal advisory track. It folds
SSE events with `phase === "informalAudit"` into five UI states:

| State | Trigger |
|---|---|
| `pending` | The first `informalAudit` event arrives ("Running informal advisory audit") |
| `noObviousIssue` | Verdict `noObviousIssue` or the matching "No obvious issues found" info event |
| `warning` | Any other verdict, or any `warning`-level event with a `{verdict, confidence, findings}` payload |
| `paused` | A high-confidence issue verdict arrives with `paused: true`; formal verification is waiting at `informalAudit` |
| `failed` | An `error`-level event (e.g. the auxiliary model errored — non-blocking) |

The panel uses `policy = pauseOnHighConfidenceIssue` per backend spec §10.8.
Low/medium-confidence advisories are warning-only. High-confidence issue
verdicts pause the run before statement formalization; the advisory still does
not determine the final verification outcome.

For a paused state the user may click **Acknowledge advisory and proceed…** to
open an inline textarea. Submitting a non-empty reason calls
`POST /v1/runs/:runId/informal-audit/acknowledge` with `{ reason }`; desktop
records the acknowledgement, clears `paused`, and resumes the same run. The
legacy `/override` route is still accepted for compatibility.

For a non-paused warning state the user may click **Acknowledge advisory…** to
record a reason without affecting the already-running formal verification. In
both cases the panel flips to an "Acknowledged" state showing the recorded
reason and timestamp.

## Verification Flow

Clicking Verify sends `POST /v1/verify` with the document snapshot,
`parsedDocumentFingerprint`, `parserVersion`, and `projectId`. The desktop
responds immediately with an `AcceptedRunResponse` containing a `runId`.

The extension then opens a fetch-based SSE connection to
`GET /v1/runs/:runId/events` and updates claim status as events arrive. The
`complete` event carries the final outcome.

### Run phases (SSE `phase` field)

| Phase | Description |
|---|---|
| `parseSnapshot` | Desktop re-parses the received document text |
| `buildGraph` | Audit graph constructed from parsed claims and edges |
| `selectContext` | Reachable upstream subgraph selected for target claim |
| `informalAudit` | Advisory LLM sanity check; verdict + findings surfaced in the side panel, never gates the outcome |
| `formalizeStatement` | Formalizer model produces Lean theorem header; checked with `sorry` |
| `faithfulness` | Backtranslation pre-filter then two-tier `S1 ↔ S2` roundtrip |
| `freezeHeader` | Theorem header hash locked; all proof work targets it |
| `proverAttempt` | Prover model attempts end-to-end proof with author NL as CoT sketch |
| `finalGate` | Trust-policy scan, frozen-header hash check, faithfulness gate |
| `complete` | Run finished; outcome emitted |

The user can cancel by closing the panel; the desktop run continues to
completion (results are persisted regardless).
