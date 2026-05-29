# Lale Backend Implementation Spec

*Companion to the Auditor Design Spec. That document covers the pipeline. This one covers topology, durable state, transport, key handling, provisioning, sandboxing, and the storage model.*

---

## 1. Topology & Cost Model

**Desktop-local app + BYOK. No cloud. Zero marginal infrastructure cost to the operator.**

- Lean + Mathlib run on the **user's** machine (their CPU).
- Model calls go from the user's machine **directly** to the user's chosen provider, paid with the user's own API key (BYOK).
- Durable state lives in **local SQLite + OS secure storage** on the user's machine.

The marginal cost per user is genuinely zero. Nothing is hosted. This is what makes a free product viable.

**Honest caveat.** Zero cost *to the operator* is paid for with setup cost *to the user*, almost all of it in provisioning a working Lean+Mathlib environment (§4). The community Lean cache (`lake exe cache get`) is what rescues this — it lets us free-ride on the Lean community CDN to provision Mathlib without hosting anything. This is **load-bearing** for the zero-cost claim. If the community cache is ever insufficient and we have to host an `.olean` bundle ourselves, hosting cost re-enters. Name it as a known fallback, not a surprise.

**No telemetry, by design.** Nothing leaves the machine except the user's own model API calls to their own provider. For unpublished mathematics this is a genuine privacy feature, not just a cost decision. Surface it as such.

### App shell

**v0 is a self-contained Node/TypeScript service** behind the localhost HTTP API (§3) — not a Tauri or Electron app yet. Rationale: the heavy logic (the shared `packages/document-parser`, pipeline orchestration, provider HTTP calls, SQLite access) is all TypeScript-shaped and shares the parser package; Lean runs as a subprocess regardless of shell, so the shell choice does not affect the pipeline. For a draft whose purpose is to validate the pipeline and find what breaks, staying in one language and iterating fast dominates binary-size concerns.

**Keep the shell decision out of the critical path** by making the desktop backend a clean service behind the localhost API. The shell then becomes a launcher + window, swappable later at low cost:

- **Electron** — everything stays TS, heavier binary.
- **Tauri + Node sidecar** — lighter shell, Node still does the work.
- **Tauri + Rust core** — lightest binary, but rewrites orchestration in Rust; most work.

Defer this until the pipeline works. Do **not** start a shell migration during v0.

---

## 2. Responsibilities

### Extension (thin interactive client)

Owns Overleaf interaction and parsing for UX. It should:

- Capture Overleaf source via `packages/overleaf-adapter`.
- Parse with `packages/document-parser`.
- Show issues, claims, adjacent proofs, explicit dependencies, upstream/downstream links, source-jump actions.
- Send verification requests to desktop (raw snapshot + parsed-document fingerprint).
- Display desktop progress events and final audit traces.
- Let the user configure non-secret UI preferences.
- Let the user acknowledge an informal advisory pause and send that decision to desktop.

It must **not** own: API keys; Lean execution; verification history; model response cache; final trust decisions; durable overrides.

### Desktop (the verifier backend)

- Store project state and verification history (SQLite).
- Store provider settings and **key references** (raw keys only in OS secure storage; never in SQLite).
- Re-parse / validate received snapshots with the shared parser.
- Build the canonical audit graph.
- Run the informal advisory audit; pause before formalization on high-confidence advisory findings until the user acknowledges; run the formal auditor pipeline.
- Run Lean locally against the project's pinned environment.
- Manage Mathlib/local retrieval.
- Cache Lean checks by **goal + environment** (§7).
- Emit progress events to the extension.
- Persist every meaningful audit artifact.

Canonical verification is based on the document text/fingerprint in the request. Extension parsing is client context only.

---

## 3. Transport (extension ↔ local desktop)

Desktop runs a **localhost HTTP server**; the extension is the client. Verification is request → accepted run id → **SSE** progress stream (or poll fallback).

**Localhost is not a security boundary.** Any web page in the user's browser can issue requests to `localhost`, and DNS-rebinding defeats naive origin checks. Required:

- **Origin allowlist** — accept requests only from the extension's origin / the Overleaf origins the extension operates on.
- **Per-install bearer token** — generated on first run, shared with the extension out of band, required on every request. Without it, any site could drive the verifier.
- Bind to `127.0.0.1` only, never `0.0.0.0`.

**Token exchange (v0): manual paste.** On first run the desktop service generates the token and displays it on a "Connect extension" screen; the user copies it into the extension's settings. This is the lowest-plumbing path, works across browsers, and the out-of-band channel is the human — which is exactly what makes the shared secret trustworthy. Rotation: regenerate on demand (e.g. if the user suspects compromise) and re-paste. *Deferred:* native-messaging auto-discovery (desktop registers a native-messaging host manifest, extension reads the token over the messaging port) is nicer UX but adds per-browser, per-OS installer plumbing; do it after v0 if onboarding friction warrants. Keep the localhost HTTP + SSE transport regardless — native messaging is only a token-bootstrap convenience, not a replacement for the transport (its message-size limits and weak streaming make it a poor fit for progress events).

*v0 status — implemented.* The desktop side prints the token to its stdout on boot (no GUI shell yet — see §1; treat the terminal as the "Connect extension" screen). The extension side renders a dedicated Connect view in the side panel whenever no token is stored or the stored token is rejected. The token is held in `chrome.storage.local` and sent on every authenticated request. A Settings drawer exposes token rotation/clear and triggers provisioning (§4).

---

## 4. Lean + Mathlib Provisioning

The biggest adoption risk, and where the user's setup cost concentrates.

- **Toolchain via `elan`.** App detects an existing install or installs `elan`, then pins the Lean version.
- **Pin Lean to the project's revision.** Default **Lean 4.15.0** (matches the ProofBridge reference setup and has cache coverage) unless the project's Mathlib revision requires otherwise.
- **Mathlib via `lake exe cache get`.** Pull prebuilt `.olean` files from the community CDN rather than building Mathlib from source (which is tens of minutes to hours). This is the step that makes provisioning tolerable and keeps the operator's cost at zero.
- **Fallback (cost-bearing, documented):** if the community cache is unavailable for a pinned revision, the user builds from source (slow) or the operator hosts an `.olean` bundle (reintroduces hosting cost). Track this explicitly.

Onboarding should show real progress through these steps; a silent multi-minute hang here is the most likely cause of abandonment.

**v0 status — implemented.** Exposed via the localhost HTTP transport (§3) as:

- `POST /v1/provision` — body `{ protocolVersion: 1, leanVersion?, mathlibRevision?, force? }`. Returns `202 { provisionId }` on a new run, `200 { provisionId, alreadyReady: true }` when the project dir already looks provisioned, `409` when a provision is in progress.
- `GET /v1/provision/:id/events` — SSE stream of `provision_event` frames (one per stdout/stderr line of the underlying commands) terminating in a `complete` frame.
- `GET /v1/provision` — current state: `status`, `leanVersion`, `mathlibRevision`, `projectDir`, `startedAt`, `finishedAt`, `error`, and a computed `projectReady`.

Step order: `detectElan → installElan (if needed) → writeProject → installToolchain → lakeUpdate → lakeCacheGet → verify`. Default pins are Lean `4.20.0` and Mathlib `v4.20.0` — Lean 4.15.0 binaries (including the mathlib `cache` executable it produces) fail to load on macOS 15 with `dyld: __DATA_CONST segment missing SG_READ_ONLY flag`; the toolchain fix landed in the 4.16/4.17 cycle, and 4.20.0 has community-cache coverage. The literal string `latest` is not a mathlib tag and would cache-miss. Windows currently rejects the auto-install path with a pointer to the upstream elan installer; install elan manually there and the remaining steps run unchanged.

The `force` flag on `POST /v1/provision` bypasses the "project already looks provisioned" short-circuit. The extension's Reprovision/Install button always sets it, because a half-built `.lake/` from a prior failed run satisfies the readiness heuristic and would otherwise silently no-op a user-initiated reinstall.

---

## 5. BYOK Key Handling & Cost Controls

### Keys

- Raw API key → **OS secure storage** only (Keychain / Credential Manager / libsecret). `apiKeyRef` in SQLite points to it; the raw key is never persisted in SQLite, never logged, never placed in a URL.
- **Never create accounts or accept provider agreements on the user's behalf.** The user supplies an existing key.

**v0 bootstrap via environment variables.** Before a settings UI exists, the desktop service reads API keys and model IDs from env vars at startup. These are resolved at call time and never persisted to SQLite:

| Variable | Purpose | Default |
|---|---|---|
| `LALE_FORMALIZER_API_KEY` / `LALE_NOVITA_API_KEY` | API key for the formalizer role | *(required for default formalizer if no keytar entry)* |
| `LALE_OPENROUTER_API_KEY` | API key for OpenRouter-backed roles | *(required for default auxiliary/prover if no keytar entry)* |
| `LALE_FEATHERLESS_API_KEY` | API key for Featherless-backed role overrides | *(optional)* |
| `LALE_API_KEY` | Legacy fallback API key used after role/provider-specific vars | *(optional dev fallback)* |
| `LALE_BASE_URL` | Shared provider base URL for OpenRouter-backed roles | `https://openrouter.ai/api/v1` |
| `LALE_FORMALIZER_BASE_URL` | Provider base URL for the `formalizer` role | `https://api.novita.ai/openai` |
| `LALE_PROVER_BASE_URL` | Provider base URL for the `prover` role | `LALE_BASE_URL` |
| `LALE_AUXILIARY_BASE_URL` | Provider base URL for the `auxiliary` role | `LALE_BASE_URL` |
| `LALE_PROVER_MODEL` | Model ID for the `prover` role | `deepseek/deepseek-prover-v2` |
| `LALE_FORMALIZER_MODEL` | Model ID for the `formalizer` role | `deepseek/deepseek-prover-v2-671b` |
| `LALE_AUXILIARY_MODEL` | Model ID for the `auxiliary` role | `openai/gpt-4o-mini` |
| `LALE_LEAN_PROJECT_DIR` | Path to provisioned Lean+Mathlib project | `~/.lale/lean-project` |
| `PORT` | Desktop HTTP server port | `8765` |

Role-specific key env vars take precedence, then provider-specific vars, then legacy `LALE_API_KEY`, then any keytar entry. Once a settings UI exists, keys will be stored via keytar and this env-var path becomes a dev-only convenience.

Lean-focused hosted alternatives:

- Featherless prover: set `LALE_PROVER_BASE_URL=https://api.featherless.ai/v1`, `LALE_PROVER_MODEL=Goedel-LM/Goedel-Prover-V2-32B`, and `LALE_FEATHERLESS_API_KEY`.
- Featherless formalizer experiment: set `LALE_FORMALIZER_BASE_URL=https://api.featherless.ai/v1` and `LALE_FORMALIZER_MODEL=Goedel-LM/Goedel-Formalizer-V2-32B`.

### Cost controls (BYOK makes these user-facing, not just quality knobs)

The user pays per call, and one run fans out: retries (§ design 3.11) × faithfulness roundtrips × (later) proof steps × prover sample budget. Without guards, one "Verify" click can silently burn real OpenRouter credit.

- **Per-run budget cap** (token or dollar), enforced before dispatch and checked between stages.
- **Visible token/cost accounting** per run, surfaced in the UI.
- **The Lean cache is a cost feature, not just a latency feature** — a cache hit is a model/Lean call the user does not pay for. Frame and surface it that way.

---

## 6. Lean Sandboxing

LLM-generated Lean is **executed on the user's machine**, and Lean can shell out via `IO` / `#eval` / side-effecting elaboration. Required (mirrors the final-gate trust check in the design spec, §3.13):

- Reject generated proofs containing `IO`, `#eval`, or side-effecting elaboration, alongside the existing `sorry` / `admit` / custom-axiom / `unsafe` / `native_decide` checks.
- Run every Lean check under a **wall-clock cap and a memory cap**.
- Treat a cap hit as `verificationBlocked` for that unit (per the retry policy), not as a proof judgment.

---

## 7. Lean Check Cache (goal + environment keyed)

Do **not** hash Lean *source text*. An LLM produces different tactic scripts for the same goal, so source-hashing yields near-zero hit rate. Cache at the level of *what is proven*, not *how*.

```ts
cacheKey = hash(
  normalizedGoalTerm,        // the elaborated Lean type to prove, alpha-normalized
  environmentFingerprint,    // imports, opened namespaces, sectioned variables,
                             // in-scope hypotheses — alpha-normalized
  leanVersion,
  mathlibRevision
)

cacheValue = {
  status,                    // ok | failed | timeout
  provenBy?: leanProofTerm,  // a known-good proof term (the "what"), re-elaborated
                             // as a cheap sanity check on hit
  diagnosticsJson,
  elapsedMs,
  createdAt,
  lastUsedAt
}
```

- **Failures are cached with a short TTL**, keyed identically. Saves re-running Lean on an obligation already known to fail under the current environment.
- A cached failure must **not** short-circuit the **intra-run** retry loop (the cache is cross-run reuse; retries are intra-run exploration).
- Because Mathlib is pinned per project (§8), `mathlibRevision` is constant within a project, so the cache **partitions by project automatically**, with cross-project sharing as a free bonus when two projects pin the same revision (the key is content-addressed on the revision, not the project id).

---

## 8. Per-Project Pinned Environment

`leanVersion` and `mathlibRevision` are **set at project creation and immutable for the project's life**, stored in `projects.settingsJson`.

Consequences:

- No mid-project Mathlib bump → no mass cache invalidation, no retrieval-index rebuild within a project.
- The retrieval index built against a project's Mathlib stays valid for the whole project.
- **Trade-off (state it plainly):** a long-lived project drifts from current Mathlib (which renames/moves declarations constantly) and cannot be "upgraded" in place. The escape hatch is **re-linking** — create a fresh project against a newer revision and re-verify. For auditing a fixed paper this is *correct*: the paper is a fixed artifact, so freezing its verification environment buys reproducibility and cache stability, which matters more than currency.

---

## 9. Verification Request Shape

```ts
interface VerificationRequest {
  protocolVersion: 1;
  requestId: string;
  projectId: string | null;
  claimId: string;
  snapshot: OverleafDocumentSnapshot;
  parsedDocumentFingerprint: string;
  parserVersion: string;
  // `mode` removed in v0 (assistive dropped; single behavior). Reserved for future.
}
```

Desktop responds immediately with an accepted run id, then streams progress (§3).

---

## 10. Storage Model (SQLite)

Schema strategy: **JSON-blob-then-promote.** For the per-attempt / per-step tables, keep stable identity columns plus `status`/`verdict`, and blob everything whose shape is still uncertain into an `artifactsJson` column. Promote a field to a real column only once (a) the shape is stable across 20+ real runs and (b) you query or filter on it. Adding a column and backfilling from JSON is cheap; altering a wrong column with data in it is not. This also lets the schema absorb whatever the prover hands back without a migration.

### 10.1 `projects`
`projectId`, `sourceKind`, `overleafProjectId`, `overleafUrl`, `name`, `createdAt`, `lastOpenedAt`, `settingsJson` *(includes the immutable `leanVersion` + `mathlibRevision` pin — §8)*.

### 10.2 `model_provider_configs`
`providerConfigId`, `projectId`, `role` (`formalizer` | `prover` | `auxiliary`), `providerKind` (`openrouter` | `openaiCompatible` | `local` | `manual`), `baseUrl`, `modelId`, `reasoningEffort`, `temperature`, `maxTokens`, `apiKeyRef` *(→ OS secure storage; never the raw key)*, `createdAt`, `updatedAt`.

**The pipeline uses three model roles, not one model.** A single `modelId` per project is insufficient because the stages have different needs, and they typically share one BYOK key (e.g. one OpenRouter key fronting many models). Roles:

- **`prover`** — end-to-end proof / proof obligations (§ design 3.10). A Lean-capable prover model. Featherless `Goedel-LM/Goedel-Prover-V2-32B` is a supported hosted option.
- **`formalizer`** — statement formalization (§ design 3.7) and re-formalization for the roundtrip check (§ design 8). Defaults to Novita-hosted `deepseek/deepseek-prover-v2-671b` because the old OpenRouter `deepseek/deepseek-prover-v2` route may have no live endpoint.
- **`auxiliary`** — cheap general-purpose language tasks: backtranslation pre-filter (§ design 8) and the informal advisory audit (§ design 3.5). A small, fast, inexpensive chat model. **Do not use the prover here** — it is the wrong tool for "translate this Lean back to English" and far more expensive.

One `apiKeyRef` may be shared across roles. v0 ships sensible defaults per role and exposes each as a config knob.

### 10.3 `document_snapshots`
`snapshotId`, `projectId`, `documentFingerprint`, `parserVersion`, `capturedAt`, `documentText`, `parsedDocumentJson`, `issuesJson`. *(Full text stored initially for reproducibility; add a retention/delete setting later.)*

### 10.4 `claim_identities`
`claimIdentityId`, `projectId`, `currentLabel`, `currentKind`, `firstSeenAt`, `lastSeenAt`, `statusCache`. *(Labels anchor identity; content fingerprints determine staleness.)*

### 10.5 `claim_revisions`
`claimRevisionId`, `claimIdentityId`, `snapshotId`, `label`, `kind`, `title`, `statement`, `body`, `proofText`, `startLine`, `endLine`, `startOffset`, `endOffset`, `claimFingerprint`, `proofFingerprint`, `dependenciesJson`.

### 10.6 `dependency_edges`
`edgeId`, `snapshotId`, `fromClaimRevisionId`, `toClaimRevisionId`, `label`, `kind` (`explicitRef` | `context` | `external`), `resolutionStatus` (`resolved` | `unresolved` | `ambiguous`), `sourceSpanJson`, `trustStatus`.

### 10.7 `audit_runs`
`auditRunId`, `projectId`, `snapshotId`, `targetClaimRevisionId`, `requestId`, `status` (`queued` | `running` | `paused` | `cancelled` | `finished`), `phase`, `startedAt`, `finishedAt`, `outcome`, `durationMs`, `leanVersion`, `mathlibRevision`, `proverConfigId`, `formalizerConfigId`, `auxiliaryConfigId`. *(`mode` column dropped.)*

All three config ID columns are nullable — a run that fails at statement formalization never invokes the prover, so its `proverConfigId` is legitimately null. These capture "what was configured for this run"; per-call detail (e.g. if a config changed mid-run after a retry) lives in `run_events`/artifacts, not in additional run columns.

`outcome` ∈ the `VerificationOutcome` union (design spec §3.14).

### 10.8 `informal_audits`
`informalAuditId`, `auditRunId`, `verdict`, `confidence`, `findingsJson`, `policy` (`warnAndContinue` | `pauseOnHighConfidenceIssue`), `paused`, `overriddenAt`, `overrideReason`. High-confidence issue verdicts use `pauseOnHighConfidenceIssue` and set `paused = 1` until acknowledged; the advisory still never determines the final outcome.

### 10.9 `statement_attempts`
`statementAttemptId`, `auditRunId`, `attemptIndex`, `status`, `artifactsJson` *(blobs: `leanSource`, `termMap`, `diagnostics`)*.

`frozen_headers`: `frozenHeaderId`, `auditRunId`, `theoremName`, `sourceHash`, `artifactsJson` *(blobs: `imports`, `parameters`, `hypotheses`, `conclusionLean`)*.

### 10.10 `faithfulness_checks`
`faithfulnessCheckId`, `auditRunId`, `kind` (`backtranslation` | `roundtrip`), `verdict` *(collapsed enum — design §8)*, `createdAt`, `artifactsJson` *(blobs: evidence)*. *(`termGrounding` and `candidateConsistency` removed from this table per §8.)*

### 10.11 `proof_steps` *(post-v0; reserved)*
`proofStepId`, `auditRunId`, `index`, `sourceText`, `status` (`pending` | `checked` | `failed` | `blocked`), `artifactsJson` *(blobs: `beforeState`, `claimedTransition`, `afterState`, `leanObligation`, `citedLabels`, `dependenciesUsed`, `diagnostics`, and a per-step `attempts[]` log)*.

In v0 end-to-end, this table is unused; the single accepted attempt is recorded on the run + final-proof artifact.

### 10.12 `retrieval_queries` / `retrieval_hits` *(post-v0; reserved)*
Queries: `retrievalQueryId`, `auditRunId`, `proofStepId?`, `queryKind`, `queryText`, `source`, `createdAt`.
Hits: `retrievalHitId`, `retrievalQueryId`, `name`, `signature`, `sourceKind` (`reachableDependency` | `mathlibLocal` | `externalHint`), `rank`, `accepted`.

### 10.13 `lean_check_cache`
`cacheKey`, `normalizedGoalHash`, `environmentFingerprintHash`, `leanVersion`, `mathlibRevision`, `status`, `provenByJson`, `diagnosticsJson`, `elapsedMs`, `createdAt`, `lastUsedAt`, `ttlExpiresAt` *(for cached failures)*. See §7.

### 10.14 `final_proof_artifacts`
`finalProofId`, `auditRunId`, `leanSource`, `leanSourceHash`, `cacheKey`, `trustPolicyViolationsJson`, `finalDiagnosticsJson`, `acceptedByLean`, `createdAt`.

### 10.15 Overrides — two classes (§11)
### 10.16 `run_events`
Append-only: `eventId`, `auditRunId`, `timestamp`, `phase`, `level` (`info` | `warning` | `error`), `message`, `payloadJson`.

---

## 11. Override And Acknowledgement Model

Two distinct user-judgment records.

### 11.1 Informal-audit acknowledgement (pre-formalization)
Stored on `informal_audits`, tied to the run. The user acknowledges a high-confidence advisory pause and continues to formal verification. Logged with reason + timestamp. Does not touch verification outcome.

### 11.2 Content-change / staleness override
When a previously-verified claim revision is edited, that claim **and every downstream claim** that was `verified` go `stale`. The author then either:

- **re-verifies** (re-runs the pipeline on the edited revision and downstream), or
- **overrides** on the grounds that the edit is *non-mathematical* (e.g. a grammar fix), marking the claim + downstream `verifiedByOverride`.

**The author's judgment is trusted.** "This edit didn't change the math" is unverifiable by construction, and for a tool where the author audits their own paper, the right design is to explain in the UI when an override is appropriate (point them at the source diff so they can see what changed) and trust them if they proceed. No structural diff, no LLM gate. The override is logged with `reason` + `createdAt`, which is enough for an audit trail.

**Direct vs transitive (kept because it's nearly free and clarifies the trail).** When the author overrides B, claims downstream of B that were `verified` inherit — but only claims the author *did not themselves edit*. A claim the author also edited needs its own override decision, so that an unrelated mathematical edit to C is never auto-blessed by an override of B. Encode the inherited case as `verifiedByTransitiveOverride` (no separate author judgment) vs `verifiedByOverride` (the claim the author directly judged). Same UI badge is fine; separable in data. *(If even this is more than you want for v0, collapse both to `verifiedByOverride` and re-derive transitivity from the dependency graph on demand.)*

`verifiedByOverride` is **derived** from a valid content-change override — it is not a normal verification and must never be conflated with one.

### Override records

Content-change override: `overrideId`, `projectId`, `claimIdentityId`, `previousClaimRevisionId`, `currentClaimRevisionId`, `previousAuditRunId`, `class` (`direct` | `transitive`), `reason`, `createdAt`.

Informal-audit acknowledgement/override: on `informal_audits` (§10.8).

---

## 12. Derived Claim Status

Extension may display a cached status; desktop can always recompute.

- `pending` — no successful audit for the current claim revision
- `checking` — an active run exists
- `verified` — latest matching revision has a verified audit
- `verifiedByOverride` — current revision covered by a (direct or transitive) content-change override from a verified revision
- `stale` — claim/proof/dependency fingerprint changed after verification
- `blocked` — unresolved dependency or document issue blocks audit
- `failed` — latest audit finished with a non-verified outcome
- `timedOut` — latest audit ended on a timeout

---

## 13. MVP Scope

**Implemented (v0):** projects (with the per-project pin); provider configs with env-var key bootstrap; document snapshots; claim identities/revisions; dependency edges; audit runs; run events; Lean check cache (goal+env keyed); final proof artifacts; statement attempts; frozen headers; faithfulness checks (`backtranslation` + `roundtrip`); all outcome classes; localhost transport with origin allowlist + bearer token; BYOK key handling + per-run budget cap; Lean sandboxing (trust-policy scan + wall-clock + memory caps); SSE progress streaming; **elan + `lake exe cache get` provisioning** with SSE progress (§4); **informal advisory track UI** in the extension, including pause/resume acknowledgement posted to `POST /v1/runs/:id/informal-audit/acknowledge`.

**Then add:** the proof-step path (`proof_steps`, retrieval tables) *only if* end-to-end faithfulness is empirically inadequate; keytar-backed settings UI for API keys (replacing env-var bootstrap); retention/delete settings; richer override UX for the content-change/staleness override (§11.2).

**First real vertical slice (mirrors design spec):** accept a snapshot → canonicalize the parsed graph → select a target claim → create an audit run → formalize the statement → check statement-with-`sorry` → statement faithfulness → freeze the header → run the prover end-to-end with the author proof as a CoT sketch → final gate → return a classified outcome.
