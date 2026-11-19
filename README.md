# lale

Lean verification for Overleaf.

lale reads the theorem environments in an Overleaf document, formalizes them in
Lean 4 with Mathlib, and checks them on your own machine. Nothing is verified in
the cloud: a local service runs Lean, and the only thing that leaves the machine
is the relevant claim, proof, surrounding hypotheses, and dependency context,
sent to the model provider under your own API key.

## What a result means

This distinction matters more than any other in the project, so it comes first.

| Mode | What it does | What a pass means |
|---|---|---|
| **Verify** (`full`) | Formalizes the statement, then asks a model to write a Lean proof of it. | The theorem is true in Lean + Mathlib. **Your written proof was not audited** — the model may close the goal by an entirely different route. |
| **Formalize only** | Formalizes the statement and runs the faithfulness checks. No proof attempt. | The statement can be expressed precisely and the formalization matches your prose. Cheap, and the fastest way to find ambiguity. |
| **Check proof steps** (`proofSkeleton`) | Splits *your* proof into the steps it argues and the results it cites. States each step in Lean, with the cited results it uses as hypotheses, checks the statement reads back as your step, proves it, then checks the steps compose to the theorem in a short proof. | Your argument holds up, step by step — and a gap is localised to a step, with the prover's account of what is missing. If you cite results lale does not prove, the pass is `verifiedGivenCitations`: your argument is checked *given* them. |

This is the mode lale is built around. A prover left free to prove a theorem
will often find its own route — on research mathematics, usually a different
one — and a pass then says nothing about the proof on the page.

Lean's kernel is the thing that proves. The model that writes candidate proofs is
called the **proposer**, because proposing is what it does; a rejected proposal
says the model failed, not that the theorem is false.

## Layout

```
apps/extension     Chrome MV3 extension: side panel, Overleaf content script
apps/desktop       The service: HTTP API on 127.0.0.1:8765, pipeline, Lean runner
apps/desktop-app   macOS menu-bar shell (Electron) that packages the service
packages/document-parser   LaTeX → claims, dependencies, ambient hypotheses
packages/lean-runner       Runs Lean, parses diagnostics, checks axioms
packages/translator        Model client, prompts, token budget
packages/protocol          Shared wire types (zod)
packages/cache             Proof cache keyed on goal + environment + toolchain
packages/ui                Shared UI primitives
```

## Requirements

- macOS (the app shell is macOS-only; the service itself is portable)
- Node ≥ 22 and pnpm ≥ 12 — `packageManager` pins pnpm 12.4.2, and pnpm will
  switch to it automatically
- ~11 GB free disk for Lean and Mathlib, downloaded on first provision
- An OpenRouter account with credit

## Development

```bash
pnpm install
pnpm desktop:dev      # service on 127.0.0.1:8765, logging to ~/Library/Logs/lale/
pnpm build:ext        # then load apps/extension/dist as an unpacked extension
pnpm typecheck        # tsc across every package; there is no linter
pnpm test             # offline regression tests; no model calls or Lean install
pnpm evals            # validate the bundled evaluation fixtures (no paid calls)
```

In a terminal the service approves its own pairing requests and says so in the
log. The packaged app asks you instead.

## Building the app and the extension package

```bash
pnpm --filter @lale/desktop-app dist       # → apps/desktop-app/release/lale-<version>-arm64.dmg
pnpm --filter @lale/extension pack:store   # → apps/extension/release/lale-extension-<version>.zip
```

The DMG is unsigned. macOS blocks a first launch: **System Settings → Privacy &
Security → Open Anyway**. Signing it properly needs an Apple Developer ID and
notarization; see `docs/chrome-web-store.md` for the extension's review path.

## How the pieces talk

The extension asks the service to pair; the app shows a prompt; on approval the
bearer token travels back over that request. The token is stored by the
extension and never typed by hand. Only an extension origin that has completed a
pairing is accepted afterwards — an unpaired one is refused even with a valid
token, since an `Origin` header is not evidence when any local process can set
one.

## Where state lives

- `~/.lale/lale.db` — projects, runs, claims, proof cache, the bearer token
- `~/.lale/lean-project` — the Lean project, Mathlib and its build artifacts
- `~/.elan` — the Lean toolchain (installed by provisioning)
- `~/Library/Logs/lale/desktop.log` — service and provisioning log
- OS keychain, service `lale` — your model provider API key

## Costs

Runs are metered in tokens against a per-run cap, and priced from the provider's
published rates before the first request. Roughly **$0.20-$2 per claim**, with a
$12.50 ceiling per run at the default 250k-token cap. A run refuses to start if
the account cannot cover a single worst-case request.

## Validation and known gaps

Parser 0.4.0 widened the fingerprint hash from 32 to 128 bits — it decides
cache reuse and staleness, and 8 hex digits was a thin margin. Every stored
fingerprint therefore changed, so claims accepted under 0.3.0 need rerunning
before reuse. New runs persist their selected mode across a pause; historic runs
without a stored mode default to `full`.

- Offline tests cover database migrations, context fingerprints, SSE framing,
  pipeline modes, staleness propagation, and the trust boundary — the scanner,
  obligation parser and Lean harness that decide what reaches the kernel. Pipeline tests stub the model, Lean, and keychain; they
  skip when the optional `keytar` module cannot load. Live Lean and browser
  integration remain manual checks. The obsolete `test:lean` command was removed.
- `pnpm evals` validates the bundled fixtures (`evals/claims/cases.json`). Six are
  Check proof steps cases with known answers: a sound proof, a true theorem with
  a false step, a false theorem with a plausible proof, a citation Mathlib can
  discharge, one it cannot, and a proof whose steps stop short of the theorem.
  A case passes only if the run fails *where* it should — a false step must be
  the step reported, not just an incomplete outcome — and a pass of a false
  theorem is flagged as a false acceptance. `--live` runs them against a running
  desktop service with paid model requests (`LALE_DESKTOP_TOKEN` required);
  `--only id,id` runs a subset.
- **Check proof steps** uses an agentic prover (`apps/desktop/src/pipeline/agent/`)
  when model prices are known. Per step, it works through typed tools (helper
  files in a per-theorem namespace, Lean checks with `sorry` allowed, `exact?`
  probes, `#check` lookups, Mathlib declaration search) within a dollar budget
  ($2 ceiling, $0.25 floor per step by default; below the floor a give-up is
  refused). It is told to justify the author's step, not to find its own route,
  and the step's statement is frozen so it cannot. Composition gets no helper
  files and at most 30 lines. Acceptance is a clean-room gate: the frozen
  statement spliced in verbatim, no trust allowances, standard axioms only, and
  the kernel's goal term equal to the one frozen beforehand. Without prices,
  steps fall back to the one-shot prover. Verify mode still uses the one-shot
  prover; the agent's free-route mode exists for it but is not wired in.
- Cited results are `def laleCiteN : Prop` premises, never axioms. Each is
  back-translated against the author's wording and tried for a cheap refutation
  (a false premise would make every step after it vacuous); one Mathlib can
  prove is discharged. A subtly false or overstated citation can still slip
  through, which is why `verifiedGivenCitations` lists them for the author to
  review.
- A claim that cites a `verifiedGivenCitations` claim inherits its assumptions:
  in Check proof steps they become premises of every step and of the result,
  so the citing claim is at best `verifiedGivenCitations` too, and the side
  panel lists them as inherited. This is conservative — every step gets them,
  not only the steps that use the cited claim. Verify cannot use such a claim
  and reports `dependencyMissing`.
- Default models are GPT-6.2 Astra for every role, with Claude Fable 5.2 as the
  supported alternative (`SUPPORTED_PROVER_MODELS`).
- Proof generation in runs today is generate-and-check, not proof search: one model call
  writes a whole tactic block and Lean adjudicates. Lean's own tactic ladder is
  tried first, for free; past that a claim gets at most four model attempts,
  bounded separately for syntax failures and unsolved goals. There is no premise
  selection and no tactic-level search.
- Feasibility tracks Mathlib's coverage. Arithmetic and finite case analysis land
  well; anything needing theory Mathlib lacks (multigraphs as multiplicity
  functions, say) will formalize but not prove.
- Provisioning readiness currently checks for project files and `.lake`, while
  its final probe only checks the Lean version. A partial Mathlib install can
  therefore appear ready after a restart.
- Extension state is shared across Overleaf tabs. Project switches and delayed
  responses need explicit isolation, and several UI actions discard errors.
- Staleness propagates transitively: editing a claim marks everything that cites
  it stale, walking the parser's resolved edges out of the stored snapshot. It
  only reaches claims present in that snapshot's parse.
