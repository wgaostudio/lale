# lale-next — guide for Codex

lale-next is the clean local-first product repo. The previous hackathon repo at
`/Users/willgao/Desktop/lale` is the reference implementation.

## Product Shape

- `apps/extension` — Chrome MV3 extension for Overleaf.
- `apps/desktop` — local companion service (Node/TypeScript) running the auditor pipeline, SQLite state, and localhost HTTP + SSE API.
- `packages/protocol` — versioned wire shapes (Zod schemas shared by extension and desktop).
- `packages/overleaf-adapter` — fragile Overleaf/CodeMirror integration.
- `packages/document-parser` — LaTeX structure parser and dependency graph builder.
- `packages/translator` — model client (OpenAI-compatible) plus formalization, backtranslation, re-formalization, and informal-audit prompt functions.
- `packages/lean-runner` — Lean subprocess executor: wall-clock + memory caps, trust-policy scan, diagnostic parser.
- `packages/cache` — SQLite-backed Lean check cache (goal + environment keyed).

## Current Milestone

The v0 auditor pipeline is implemented end-to-end:

- Desktop: SQLite schema (all §10 tables), bearer-token auth + origin allowlist, SSE progress streaming, per-run budget cap, auditor pipeline (parse → build graph → select context → informal advisory → formalize statement → sorry check → faithfulness → freeze header → proving attempt → retry loop → final gate → classified outcome). There is no separate prover role: the formalizer model (DeepSeek Prover V2 671B on Novita by default, or Goedel Prover V2 32B on Featherless) handles both formalization and proving; configure via `LALE_FORMALIZER_BASE_URL` / `LALE_FORMALIZER_MODEL`.
- Desktop: Lean + Mathlib provisioning via `elan` + `lake exe cache get`, exposed as `POST /v1/provision` with SSE progress at `GET /v1/provision/:id/events` and state at `GET /v1/provision`. Defaults: Lean `4.20.0`, Mathlib `v4.20.0` (Lean 4.15.0 binaries fail on macOS 15 with the `__DATA_CONST` SG_READ_ONLY dyld error; the fix landed mid-4.16/4.17. A literal `latest` cache-misses against the community CDN, see backend spec §4).
- Extension: sends `VerificationRequest` with `projectId`, `parsedDocumentFingerprint`, `parserVersion`; receives `AcceptedRunResponse`; streams run events via SSE fetch.
- Extension: informal advisory track UI — verdict/confidence/findings panel inside the claim detail view, with inline acknowledgement form. High-confidence issue verdicts pause at `informalAudit`; `POST /v1/runs/:id/informal-audit/acknowledge` records the reason and resumes the same run. Low/medium-confidence advisories remain warning-only.
- Extension: Connect-to-desktop onboarding (paste bearer token printed by the desktop service into a settings input; stored in `chrome.storage.local`); Settings drawer with token rotation, keytar-backed API key management (per-provider set/clear via `PUT/DELETE /v1/provider-configs/:id/key`), and Lean + Mathlib provisioning controls (start, live SSE progress, status pill); a callout in the main view when Lean isn't yet provisioned.
- All packages implemented (translator, lean-runner, cache).

Next: richer override UX for content-change/staleness overrides (§11.2); retention/delete settings. Do not add an LLM fallback for dependency discovery.

## Conventions

- Extension state is a mirror. The desktop app owns durable project state,
  verification history, overrides, model keys, and cache records.
- The extension may store lightweight UI preferences only.
- API keys never live in the extension.
- Claim dependencies come from explicit `\ref`, `\cref`, `\Cref`, `\autoref`,
  and `\eqref` references.
- Proofs should immediately follow their claim for v1.
- Cache keys are based on the normalized elaborated goal term + environment fingerprint (imports, hypotheses, namespaces) + leanVersion + mathlibRevision — NOT on Lean source text. An LLM produces different tactic scripts for the same goal, so source-hashing yields near-zero hit rate. See backend spec §7.

## UI Direction

Use a quiet technical/editor-native design language: compact panels, clear
status, source-first evidence, and restrained semantic color. Avoid chat-like or
marketing-like UI.
