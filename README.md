# lale-next

Local-first Lean verification for Overleaf.

`lale-next` is the clean product repo for lale. It pairs a Chrome MV3
extension with a local desktop companion service: the extension reads the
Overleaf document and shows status, while the desktop service owns durable
state, model configuration, Lean/Mathlib provisioning, audit runs, and the
SQLite-backed verification cache.

The previous hackathon implementation at `https://github.com/Defying-gravity62442/lale` is kept
as a reference implementation.

## What It Does

- Parses an Overleaf LaTeX document into claims, adjacent proofs, explicit
  references, document issues, and a dependency graph.
- Sends verification requests from the extension to a localhost desktop API.
- Runs an auditor pipeline:
  parse snapshot -> build graph -> select context -> informal advisory ->
  formalize statement -> `sorry` check -> faithfulness checks -> freeze header
  -> proof attempt -> final gate.
- Provisions Lean and Mathlib locally through `elan` and `lake exe cache get`.
- Stores projects, snapshots, claim revisions, run events, overrides, provider
  config, and cache records in `~/.lale/lale.db`.
- Stores provider API keys outside the extension, either in environment
  variables or the OS keychain via `keytar`.

The extension is intentionally a mirror. It may keep lightweight UI state in
`chrome.storage.local`, but the desktop service is the source of truth.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `apps/extension` | Chrome MV3 extension for Overleaf, built with Vite and `@crxjs/vite-plugin`. |
| `apps/desktop` | Node/TypeScript localhost service, SQLite schema, auth, provisioning, SSE, and auditor pipeline. |
| `packages/protocol` | Zod schemas for the versioned extension-to-desktop wire protocol. |
| `packages/overleaf-adapter` | Overleaf/CodeMirror document capture and source navigation adapter. |
| `packages/document-parser` | LaTeX claim parser, proof adjacency detection, package/issues detection, and explicit-reference graph builder. |
| `packages/translator` | OpenAI-compatible model client and formalization, backtranslation, re-formalization, proof, and informal-audit prompts. |
| `packages/lean-runner` | Lean subprocess executor with wall-clock cap, memory cap, diagnostics parser, and trust-policy scan. |
| `packages/cache` | SQLite-backed Lean check cache keyed by normalized goal/environment/Lean/Mathlib, not source text. |
| `docs` | Design specs and extension flow notes. |
| `evals` | Small repeatable evaluation fixtures. |

## Prerequisites

- Node.js `>=20.10`
- pnpm `>=9`
- Chrome or Chromium with extension developer mode enabled
- Model API keys for:
  - formalizer/prover model, defaulting to DeepSeek Prover V2 671B on Novita
  - auxiliary model, defaulting to OpenRouter `openai/gpt-chat-latest`

Lean and Mathlib do not need to be installed by hand. The desktop service can
provision them into `~/.lale/lean-project` through the side panel or HTTP API.

## Setup

Install dependencies:

```sh
pnpm install
```

Start the desktop service:

```sh
pnpm --filter @lale/desktop dev
```

On startup it prints the localhost port, database path, Lean project path, and
the extension connection bearer token:

```text
lale desktop service starting
Port:        8765
DB:          /Users/<you>/.lale/lale.db
Lean project: /Users/<you>/.lale/lean-project

Extension connection token (paste into extension settings):
  <token>
```

Build the extension:

```sh
pnpm --filter @lale/extension build
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select `apps/extension/dist`.
5. Open an Overleaf project at `https://www.overleaf.com/project/...`.
6. Open the lale side panel and paste the token printed by the desktop service.

Configure model keys in the extension Settings UI. The side panel exposes the
supported formalizer choices and auxiliary OpenRouter key; saved keys are sent
to the desktop service and stored via the desktop keychain integration, not in
the extension.

Environment variables are still supported for local development and CI-style
server bootstrapping. They are optional when keys are configured through
Settings:

```sh
export LALE_NOVITA_API_KEY=...
export LALE_OPENROUTER_API_KEY=...
```

Optional provider/model overrides for the desktop process:

```sh
# Default formalizer
export LALE_FORMALIZER_BASE_URL=https://api.novita.ai/openai
export LALE_FORMALIZER_MODEL=deepseek/deepseek-prover-v2-671b

# Alternative: Goedel Prover V2 32B on Featherless
export LALE_FEATHERLESS_API_KEY=...
export LALE_FORMALIZER_BASE_URL=https://api.featherless.ai/v1
export LALE_FORMALIZER_MODEL=Goedel-LM/Goedel-Prover-V2-32B
```

For extension development with Vite:

```sh
pnpm --filter @lale/extension dev
```

## Provision Lean + Mathlib

The default toolchain is Lean `4.20.0` with Mathlib `v4.20.0`. These defaults
avoid the macOS 15 dyld issue affecting older Lean binaries and match a tagged
Mathlib revision with community cache coverage.

From the extension:

1. Open Settings.
2. In "Lean + Mathlib", click "Install Lean + Mathlib".
3. Watch the streamed provisioning log.

From curl:

```sh
TOKEN=<token from desktop startup>

curl -s -X POST http://127.0.0.1:8765/v1/provision \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"protocolVersion":1}'
```

Then stream events from the returned `provisionId`:

```sh
curl -N -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8765/v1/provision/<provisionId>/events
```

Provisioning creates a local Lake project under `~/.lale/lean-project` unless
`LALE_LEAN_PROJECT_DIR` is set.

## Verification Flow

1. The content script captures the current Overleaf CodeMirror document and
   parses it with `@lale/document-parser`.
2. The side panel shows package/issues, dependency graph, and claim list.
3. If the Overleaf project is not linked, the user creates a local lale project.
4. Clicking Verify sends `POST /v1/verify` with the snapshot, parser version,
   document fingerprint, project id, and claim id.
5. The desktop service creates an audit run and immediately returns an accepted
   response with `runId`.
6. The extension streams `GET /v1/runs/:runId/events` and updates the claim UI.
7. The final `complete` SSE event carries the verification outcome.

Supported claim environments are `theorem`, `proposition`, `claim`, `lemma`,
`corollary`, `definition`, `postulate`, and `axiom`. Proofs are required for
verifiable theorem-like claims and optional for definitions, postulates, and
axioms. Dependencies come only from explicit `\ref`, `\cref`, `\Cref`,
`\autoref`, and `\eqref` references. There is no LLM fallback for dependency
discovery.

## Verifier Outcomes

The final run result uses `VerificationOutcome` from `packages/protocol`.

| Outcome | Meaning |
| --- | --- |
| `verified` | The statement was formalized, the proof was accepted by Lean, and the final gate passed. |
| `formalized` | A proof-optional item, such as a definition, was faithfully formalized and accepted without a proof attempt. |
| `malformedClaim` | The claim could not be translated into a well-typed Lean statement after retries. |
| `malformedProof` | A proof was required but no adjacent proof text reached the prover. |
| `claimContradicted` | Reserved outcome for claim-level contradiction classification. |
| `proofContradicted` | Reserved outcome for proof-level contradiction classification. |
| `proofIncomplete` | Lean saw unsolved goals after the allowed proof retries; the proof appears incomplete. |
| `proofDoesNotSupportClaim` | Faithfulness or final-gate checks found that the formal/proved content does not support the original claim. |
| `formalizationUnfaithful` | A proof-optional item was formalized, but the formalization failed faithfulness checks. |
| `dependencyMissing` | An explicit referenced dependency could not be resolved or prepared for the target claim. |
| `verificationBlocked` | Verification could not complete because of infrastructure, model, timeout, trust-policy, budget, or restart interruption. |

In the current prover loop, proof attempts that repeatedly fail with
syntax/elaboration/type errors finish as `verificationBlocked`; attempts that
reach Lean but leave unsolved goals finish as `proofIncomplete`.

## Informal Advisory

Every run includes an auxiliary informal advisory pass before formalization.
The advisory can report `noObviousIssue`, `possibleTypo`, `possibleGap`,
`possibleContradiction`, `possibleClaimProofMismatch`, or `uncertain`.

Low- and medium-confidence findings are warning-only. High-confidence issue
findings pause the run at `informalAudit`; the user must acknowledge the
advisory with a reason before the same run resumes. The advisory does not
decide the final verification outcome.

## Local API

The desktop service listens on `http://127.0.0.1:8765` by default. Except for
health checks, routes require `Authorization: Bearer <token>`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Lean/cache health. |
| `POST` | `/v1/projects/lookup` | Resolve an Overleaf project to a local project and claim statuses. |
| `POST` | `/v1/projects` | Create a local project. |
| `GET` | `/v1/projects/:id` | Fetch project metadata. |
| `POST` | `/v1/projects/:id/overrides` | Record content-change override. |
| `POST` | `/v1/verify` | Start a verification run. |
| `GET` | `/v1/runs/:id` | Fetch final/current run result. |
| `GET` | `/v1/runs/:id/events` | Stream run events over SSE. |
| `POST` | `/v1/runs/:id/informal-audit/acknowledge` | Record advisory acknowledgement and resume if paused. |
| `GET` | `/v1/provider-configs` | List model provider config summaries. |
| `PATCH` | `/v1/provider-configs/:id` | Switch active formalizer config. |
| `PUT` | `/v1/provider-keys/:provider` | Store a named provider key in keychain. |
| `DELETE` | `/v1/provider-keys/:provider` | Clear a named provider key. |
| `PUT` | `/v1/provider-configs/:id/key` | Store a provider-config key in keychain. |
| `DELETE` | `/v1/provider-configs/:id/key` | Clear a provider-config key. |
| `POST` | `/v1/provision` | Start Lean/Mathlib provisioning. |
| `GET` | `/v1/provision` | Fetch provisioning state. |
| `GET` | `/v1/provision/:id/events` | Stream provisioning events over SSE. |

## Development Commands

```sh
pnpm --filter @lale/desktop dev       # run localhost desktop service
pnpm --filter @lale/extension dev     # run extension dev build
pnpm --filter @lale/extension build   # build extension into apps/extension/dist
pnpm typecheck                        # typecheck all workspaces
pnpm lint                             # alias for workspace TypeScript checks
pnpm --filter @lale/translator evals  # run translator eval harness
```

## Useful Environment Variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Desktop service port, default `8765`. |
| `LALE_LEAN_PROJECT_DIR` | Lean/Lake project directory, default `~/.lale/lean-project`. |
| `LALE_MODEL_TIMEOUT_MS` | Model request timeout, default `90000`. |
| `LALE_FORMALIZER_BASE_URL` | OpenAI-compatible formalizer endpoint. |
| `LALE_FORMALIZER_MODEL` | Formalizer/prover model id. |
| `LALE_NOVITA_API_KEY` | API key for the default Novita formalizer. |
| `LALE_FEATHERLESS_API_KEY` | API key for Featherless formalizer option. |
| `LALE_AUXILIARY_BASE_URL` | Auxiliary endpoint. |
| `LALE_AUXILIARY_MODEL` | Auxiliary model id. |
| `LALE_OPENROUTER_API_KEY` | API key for the default auxiliary provider. |
| `LALE_API_KEY` | Last-resort generic API key fallback. |

See `.env.example` for the common model-provider setup.

## Data Locations

- SQLite database: `~/.lale/lale.db`
- Lean project: `~/.lale/lean-project`
- Extension token storage: `chrome.storage.local["lale.bearerToken"]`
- Provider keys: environment variables or OS keychain refs such as
  `lale:novita.ai`, `lale:featherless.ai`, and `lale:openrouter.ai`

## Troubleshooting

- **Side panel stays on Connect**: the token is missing or stale. Restart the
  desktop service and paste the current token from the terminal.
- **Desktop reachable but token rejected**: clear the token in Settings and
  paste the current startup token.
- **Verification fails immediately**: check that the project is linked, Lean is
  provisioned, and both formalizer and auxiliary keys are configured.
- **Provisioning fails during `lake exe cache get`**: the Mathlib revision may
  not have community cache coverage. Use a tagged revision that matches the
  Lean toolchain.
- **Extension sees no claims**: reload the Overleaf tab after loading the
  extension. The content script only runs on
  `https://www.overleaf.com/project/*`.
- **A theorem is ignored or blocked**: add a stable `\label{...}` and place the
  proof immediately after the claim.

## Design Constraints

- API keys never live in the extension.
- The desktop app owns project state, verification history, overrides, model
  keys, and cache records.
- Claim dependencies are explicit LaTeX references only.
- Cache keys are based on normalized goal term, environment fingerprint, Lean
  version, and Mathlib revision.
- Final proofs are rejected if the trust-policy scan finds `sorry`, `admit`,
  `unsafe`, `#eval`, `native_decide`, `IO`, custom `axiom`, or `opaque`.
