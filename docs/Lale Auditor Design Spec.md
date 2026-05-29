# Lale Auditor Design Spec

*Pipeline / algorithm document. Companion to the Backend Implementation Spec, which covers topology, storage, transport, key handling, and provisioning. This document covers **what the auditor does**; the backend spec covers **the world it does it in**.*

---

## 1. Goal

Lale verifies a single proposition:

> A faithful Lean formalization of the author's written proof verifies the author's written claim, using only the document context and the project's pinned Mathlib/Lean environment.

The emphasis is on **faithful** and on **the author's proof**. Lale is an *auditor*, not a *prover*. The distinction is load-bearing and dictates the whole design:

- A prover answers "is this claim true?" by finding *some* proof.
- An auditor answers "does *this* proof support this claim?" by checking the author's actual argument.

The underlying model (DeepSeek-Prover-V2 in v0; see §10) is a prover. It finds *a* proof. On its own it would happily pass a hand-wavy or subtly broken author argument whenever the theorem happens to be true by some other route. The auditing property therefore does **not** come from the model. It comes from the faithfulness layer (§8) wrapping the model. The model is a swappable component; the faithfulness layer is the product.

### Operating assumptions (v0)

- **Self-contained papers.** Every dependency a proof needs is either present in the document or available in the project's pinned Mathlib/Lean. No external-source resolution.
- **Per-project immutable environment.** Lean version and Mathlib revision are pinned at project creation and never change within a project's life. See backend spec.

---

## 2. Three Tracks

```
Document graph track
  parses Overleaf source into stable nodes, edges, spans, fingerprints, issues

Formal audit track
  produces evidence-backed verification outcomes against the pinned environment

Informal advisory track
  cheap LLM sanity checks; may warn or pause; does NOT determine the final outcome
```

The informal track can pause UX on a high-confidence finding. The user may acknowledge the advisory and continue to formal verification. The acknowledgement is logged. Formal verification proceeds independently of the informal verdict once the pause is cleared.

---

## 3. Pipeline

### 3.1 Capture Snapshot

Input: Overleaf document text, target claim id, project id/URL, timestamp, the project's pinned Lean/Mathlib environment info.

Output: immutable `documentFingerprint`, target `claimFingerprint`, target `proofFingerprint`.

### 3.2 Parse Document

`packages/document-parser` is the front door. Output: claims, adjacent proofs, explicit reference edges, source spans, document issues, dependency edges, package/theorem-definition metadata.

The desktop re-parses or validates the received snapshot using the shared parser. Extension parsing is useful client context; canonical verification is based on the received document text/fingerprint.

### 3.3 Build Audit Graph

Normalize the parsed document into an auditor graph.

Nodes: claim nodes; proof nodes attached to claims; definition/axiom/postulate nodes; external-reference placeholders for refs that cannot resolve locally (rare under the self-contained assumption); later, macro/notation/section-context nodes if needed.

Edges:

```ts
{
  fromId: string;
  toId: string;
  kind: "explicitRef" | "proofAttachment" | "context" | "external";
  label?: string;
  sourceSpan?: SourceSpan;
  trustStatus: "unverified" | "verified" | "trusted" | "missing" | "stale";
}
```

### 3.4 Select Reachable Context

For the target claim, select the reachable upstream subgraph: the target claim, its adjacent proof, explicitly referenced local claims, definitions/postulates/axioms reachable through refs, and the source metadata needed for UI explanation. This selected context is the formal audit boundary.

### 3.5 Run Informal Advisory Audit

Before statement formalization, run a cheap LLM sanity audit over the target claim, proof, and selected context.

```ts
type InformalAuditVerdict =
  | "noObviousIssue"
  | "possibleTypo"
  | "possibleGap"
  | "possibleContradiction"
  | "possibleClaimProofMismatch"
  | "uncertain";
```

Policy: pause only on high-confidence issue verdicts; user may acknowledge and proceed; acknowledgement is logged. Low/medium-confidence advisories are shown but do not gate formal verification. The advisory verdict never determines the final verification outcome.

*v0 status:* the audit runs and its verdict/findings are surfaced in the extension under an "Informal advisory" panel (see `docs/extension-flow.md`). The `pauseOnHighConfidenceIssue` policy is wired: high-confidence issue verdicts set the run to `paused` at `informalAudit`; `POST /v1/runs/:id/informal-audit/acknowledge` records the reason/timestamp on `informal_audits` and resumes the same run.

### 3.6 Prepare Claim Context

Build a `NormalizedClaimContext`: target statement text, target proof text, selected upstream dependencies, known labels and source spans, local definitions/statements already verified or trusted, unresolved dependencies, relevant parser issues. Record any unresolved references now.

### 3.7 Formalize Statement

Formalize **only the statement** first.

Output: Lean theorem header; explicit parameter/hypothesis/conclusion structure; natural-language→Lean term map; referenced constants/types/classes; statement attempts.

Check the statement in Lean with `sorry`. If it cannot be assigned a stable, type-checking meaning after the retry budget, classify as `malformedClaim`.

**Term grounding lives here, not in the faithfulness track.** If the statement type-checks against the pinned environment, its constants resolve by definition. A statement that does not type-check is a malformed statement, not a faithfulness failure.

### 3.8 Check Statement Faithfulness

Run faithfulness checks on the statement *before* proof work. See §8 for the aggregation rule. The check is roundtrip-dominant; backtranslation is a soft pre-filter.

### 3.9 Freeze Header

Once the statement passes Lean and faithfulness, freeze: theorem name, imports, parameters, hypotheses, conclusion, allowed dependency declarations. All proof work targets this frozen header. Its hash is recorded; a changed header at the final gate is a failure (§3.13).

### 3.10 Proof Attempt (v0: end-to-end)

**v0 skips author-intent NL segmentation.** Rationale: DeepSeek-Prover-V2 is trained on recursive *formal* subgoal decomposition; it decomposes the formal goal into formal subgoals internally. That is a different decomposition from segmenting the NL proof into author-intent steps, and doing our own NL segmentation first is redundant effort for the draft. So v0 feeds:

```
frozen header
+ author's NL proof, supplied as a chain-of-thought sketch
+ selected reachable context
+ local retrieval (§7)
-> prover end-to-end attempt
-> Lean check against the frozen header
-> classified result
```

The author's proof is supplied as a sketch, which *nudges* the prover toward the author's argument but does not constrain it. Constraint comes from faithfulness (§8), not from the prompt.

**Deferred to post-v0 (the proof-step DAG path):** if end-to-end faithfulness is empirically poor, segment the NL proof into author-intent steps, build a proof-step DAG, draft per-step obligations, and audit step-by-step. The schema reserves room for this (see backend spec, proof-step artifacts). Decide to build it from data, not in advance.

### 3.11 Retry Loop (translation-with-feedback)

Because the author already wrote the proof, the model's job is **translation**, not proof search. A retry re-translates the same argument given the previous Lean error — it does not search for a different proof. Failure handling by error class:

| Lean failure | Meaning | Policy |
|---|---|---|
| syntax / elaboration error | model wrote invalid Lean | retry up to **N=3** with the error fed back; recoverable |
| wrong / unknown lemma name | bad Mathlib name | retry with error + re-run retrieval (§7) |
| type mismatch | wrong lemma applied | retry with error |
| unsolved goals | tactics didn't close the goal | retry up to **N=2**, then classify `proofIncomplete` |
| timeout | bad proof path | do **not** retry; classify `verificationBlocked` for that unit |

The cache (backend spec) is for **cross-run** reuse. A cached *failure* must not short-circuit the *intra-run* retry loop.

**Critical outcome distinction.** Exhausting retries on *unsolved goals* is evidence the author's argument has a gap → `proofIncomplete` ("we found a gap"). Exhausting retries on *syntax/elaboration* errors means we never got valid Lean out the door → `verificationBlocked` ("our formalizer failed; we can't conclude anything about your proof"). These are very different messages to the author and must not collapse into one. The failure class is carried in diagnostics.

### 3.12 Compose Final Proof

(Relevant when the step path is active; in v0 end-to-end the composed proof is the single accepted attempt.) Assemble checked fragments against the frozen header, preserving trace IDs back to source.

### 3.13 Final Gate

Emit `verified` only if **all** hold:

- Lean accepts the final source against the pinned environment.
- Frozen header is unchanged (hash match).
- No `sorry`, `admit`, custom axioms, `unsafe`, `native_decide` trust holes, or opaque trust violations.
- **No side-effecting Lean** in generated code: no `IO`, no `#eval`, no side-effecting elaboration (this is both a trust and a sandboxing requirement; see backend spec).
- Dependencies used are reachable and allowed.
- The proof reaches the frozen claim.
- The faithfulness verdict is acceptable (§8).

### 3.14 Outcome Classification

```ts
type VerificationOutcome =
  | "verified"
  | "malformedClaim"            // statement has no stable type-checking meaning
  | "malformedProof"            // proof text cannot be made sense of as an argument
  | "claimContradicted"         // see note
  | "proofContradicted"         // proof relies on inconsistent assumptions
  | "proofIncomplete"           // genuine gap: unsolved goals after retry
  | "proofDoesNotSupportClaim"  // proof is valid but does not reach the frozen claim
  | "dependencyMissing"         // a cited local label does not resolve (rare; self-contained)
  | "verificationBlocked";      // formalizer/toolchain failure, NOT a proof judgment
```

**`claimContradicted` is typo-flavored, not "this theorem is false."** Detecting a genuinely false theorem requires counterexample search, which is not in the pipeline. In practice this outcome fires for a self-contradictory *statement* (e.g. a typo producing `n > 0 ∧ n < 0`), where strong formal evidence (inconsistent hypotheses) is available. Most suspected typos stay advisory (§3.5) or become a narrower proof/claim failure after formal evidence.

---

## 8. Faithfulness Aggregation

Two checks, with roundtrip dominant:

- **`roundtrip`** — the only check that produces machine-checkable evidence; dispositive. Mechanism: take the candidate formalization `S1`; backtranslate it to natural language with the auxiliary model; re-formalize that NL to `S2` with the formalizer; then discharge the Lean goal `S1 ↔ S2`. (The shorthand "prove original ↔ formalized" is *not* literal — the original is natural language and has no canonical Lean term, so there is nothing to put on one side of the biconditional. The re-formalization path is the actual implementation.)

  **Two-tier equivalence check.** The `S1 ↔ S2` obligation uses two tiers, in order:

  - **Tier 1 (no LLM):** run Lean directly with a short tactic budget (`rfl` / `simp` / `decide` / `omega` / `norm_num`-class automation), under a wall-clock cap. Closes → `faithful`. This is the common case and should never spend a model call.
  - **Tier 2 (prover model, only if tier 1 fails):** ask the `prover` model to write a proof of `S1 ↔ S2`, but under a *capped* sample/time budget — not unbounded search. A few attempts in the loop, then stop.
  - If tier 2 also fails to close → `unfaithful` or `needsHumanReview`, **not** a hard claim of inequivalence.

  **Keep the bounded-budget discipline on both tiers.** If tier 2 gets unbounded search, a failure stops being informative: you cannot tell "genuinely inequivalent" from "prover couldn't find it." The cap is what keeps a tier-2 failure meaningful.

  **Malformed `S2`.** If the re-formalization step produces an `S2` that does not type-check, the `S1 ↔ S2` goal cannot even be formed. Treat this as `needsHumanReview` (or retry the re-formalization), never as evidence about `S1`'s faithfulness — it is a failure of the re-formalization step, not an inequivalence signal.
- **`backtranslation`** — translate the Lean back to English (auxiliary model) and compare to the original. LLM-vs-LLM agreement: cheap, weak, used only as a fast pre-filter.

Term grounding is **not** a faithfulness check — it lives in statement validity (§3.7); if the statement type-checks against the pinned environment, its terms are grounded. Candidate self-consistency is **not** a faithfulness check either; if you want it, use it as an internal best-of-N *selection* signal for the formalizer, never as a verdict.

**Verdict enum.** The verdict says *whether* the formalization is faithful, not *how* it fails — roundtrip yields equivalence/inequivalence, not a labeled failure mode. The detail of an unfaithful verdict goes in the diagnostics text, not the enum:

```ts
type FaithfulnessVerdict =
  | "faithful"          // roundtrip passed
  | "likelyFaithful"    // roundtrip skipped (too expensive this attempt); pre-filter clean
  | "unfaithful"        // roundtrip failed, or pre-filter found a clear disagreement
  | "needsHumanReview"; // concrete trigger: backtranslation and roundtrip disagree
```

**Aggregation (pure function of the check results):**

1. Run `backtranslation` as a fast pre-filter. Clear disagreement → `unfaithful`. Stop.
2. Otherwise run `roundtrip`. Pass → `faithful`. Fail → `unfaithful`.
3. `roundtrip` skipped for cost and pre-filter clean → `likelyFaithful`.
4. `backtranslation` and a passing `roundtrip` disagree → `needsHumanReview`, log the disagreement.

This matches what purpose-built systems converge on (roundtrip / bidirectional-equivalence as the strong signal). It is the part of the design that makes Lale an auditor rather than a prover, so it is the part to invest in.

---

## 10. Model

**v0 default:** DeepSeek-Prover-V2-671B via OpenRouter (BYOK — the user's key, the user's spend). Behind a **swappable provider interface**, so the model is a hyperparameter, not a foundation. The 7B variant is the local fallback if the user prefers no API spend and has the hardware.

The model is a prover. v0 supplies the author's NL proof as a CoT sketch and relies on §8 for the auditing property. When the real model bake-off happens later, benchmark the current field **on the actual paper corpus**, not on MiniF2F — the published MiniF2F numbers are competition-math, extreme-sample-budget ceilings and will not predict performance on real paper proofs.

**Three model roles, not one** (storage in backend spec §10.2): `prover` (end-to-end proof; DeepSeek-Prover-V2 default), `formalizer` (statement formalization §3.7 and roundtrip re-formalization §8), and `auxiliary` (cheap general model for backtranslation §8 and the informal advisory audit §3.5 — never the prover). All can share one BYOK key.

---

## 17. Run Artifacts

Each run produces a durable record (see backend spec for storage): document fingerprint; target claim/proof fingerprints; selected dependency subgraph; informal audit result + acknowledgement status; statement attempts; frozen header; faithfulness checks; (post-v0) proof-step DAG; retrieval queries/hits; proof audit steps or the end-to-end attempt; final Lean source; final diagnostics; outcome.

---

## v0 Vertical Slice

```
snapshot
  → parse
  → build audit graph
  → select reachable context
  → formalize statement
  → check statement with `sorry`
  → statement faithfulness (§8)
  → freeze header
  → prover end-to-end attempt, author proof as CoT sketch (§3.10)
  → retry loop (§3.11)
  → final gate (§3.13)
  → classified outcome (§3.14)
```

NL-proof segmentation, the proof-step DAG, and step-level retrieval are **deferred** and built only if end-to-end faithfulness is empirically inadequate.
