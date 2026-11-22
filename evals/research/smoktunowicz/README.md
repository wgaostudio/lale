# Smoktunowicz (2006): an end-to-end research run

A. Smoktunowicz, *There are no graded domains with GK dimension strictly
between 2 and 3*, Invent. Math. **164** (2006), 635–640.

This checks the paper the way lale is meant to be used: claim by claim,
following the author's argument, with the results it cites listed as
assumptions rather than re-proved. It is not a re-run of the Autoform-Hard
result, where GPT-6.2 Astra proved Theorem 1 by its own route from an
expert-written statement. Here lale has to formalize the definitions and
statements itself and go *through* the cited theorems (Bergman, Small–Warfield,
Artin–Stafford, Năstăsescu–Van Oystaeyen), none of which is in Mathlib.

## The source

The paper is Springer's and is not in this repository. Supply a local reading
copy (LaTeX). The one this was prepared against is headed *"Corrected reading
copy. Editorial changes include the hypotheses and proof of Lemma 3"*, so Lemma
3 as checked is the editor's version, not the published one. A run on the
published Lemma 3 would be a separate, and interesting, test.

`apps/desktop/src/research/smoktunowicz.ts` turns the reading copy into the
test copy, written to `local/test-copy.tex` (gitignored). Every edit is listed
there with its reason. In short:

- labels on the six results, and `\ref`s where the proofs say "by Lemma 3";
- the proof of Theorem 1, which closes the paper, attached to Theorem 1;
- three supplied definitions, marked as such: GK dimension (as in
  Krause–Lenagan), *finitely graded* (the paper's own sentence), and the graded
  quotient ring with its degree-zero part $D$.

No statement's mathematics and no proof's argument is changed. An edit whose
anchor is missing or ambiguous stops the transform, so a different copy of the
paper fails instead of producing a quietly different test.

## Running it

On the Mac, with Lean and Mathlib provisioned and credit on the OpenRouter key:

```bash
pnpm desktop:dev
```

```bash
export LALE_DESKTOP_TOKEN=$(sqlite3 ~/.lale/lale.db "SELECT value FROM install_config WHERE key = 'bearerToken'")
```

```bash
pnpm research -- --source ~/path/to/graded-domains-corrected.tex --budget hard --max-usd 150
```

To run it from the side panel instead, write the test copy without starting a
run, paste `evals/research/smoktunowicz/local/test-copy.tex` into a private
Overleaf project, and check the claims there in the same order:

```bash
pnpm research -- --source ~/path/to/graded-domains-corrected.tex --prepare-only
```

Options: `--model openai/gpt-6.2-astra|anthropic/claude-fable-5.2`,
`--only lem:3,thm:main`, `--timeout-minutes 240` (per claim). Claims run in
dependency order — `def:gk def:fg def:q lem:3 lem:1 lem:2 thm:as thm:3
thm:main` — in one project, so each sees those before it. The spend cap is
checked between claims; a claim already running is bounded by its per-step
ceiling ($25 a step on the hard budget), not by the cap. Start with
`--only def:gk,def:fg,lem:3` to see the setup work before paying for the rest.

The report goes to `reports/research-smoktunowicz-<time>.md` (and `.json`): each
claim's outcome, each step's status with the prover's account of any gap, and
what became of each cited result.

## What to expect

Predictions, written before any run, so the run can be read against them.

| Claim | Expectation |
|---|---|
| `def:gk`, `def:fg` | Formalized. GK dimension needs a `limsup` of `log` ratios over finite-dimensional subspaces; Mathlib has the pieces. |
| `def:q` | The riskiest definition. It asserts structure ($D$ a division ring, $Q(R)=D[z,z^{-1};\sigma]$) that is a theorem of Năstăsescu–Van Oystaeyen, not a definition. Expect the formalizer to define $D$ as the degree-zero fractions and the faithfulness check to flag the rest. |
| `lem:3` | Elementary counting plus the GK definition. The most likely to be proved outright. |
| `lem:1` | Hard to state: generic linear combinations over $K(X)$ with infinitely many indeterminates, and the localization $A(X)$. Its proof says "the proof in the case when the former holds is similar" — a step lale should report as unproved unless the prover supplies it. |
| `lem:2` | Builds on Lemma 1 and ends in a GK-dimension estimate over $K(X)$. Likely incomplete; where it stops is the interesting part. |
| `thm:as` | Its proof is citations only. Expect `verifiedGivenCitations`, with Artin–Stafford Theorems 0.5 and 1.15, Bergman's Gap Theorem and Small–Warfield as assumptions. |
| `thm:3` | The paper's main new argument. Also uses facts stated without proof ($\GKDim R(X)=\GKDim R$ over $K(X)$; $D(X)\subseteq P_0$), which segmentation should list as citations or leave as steps. Expect several hard steps. |
| `thm:main` | If `thm:as` and `thm:3` pass, conditionally or not, expect `verifiedGivenCitations` with every assumption inherited and listed. Otherwise `dependencyMissing`. |

The best realistic result is the main theorem verified *given* the literature
it cites — a check of the author's own argument. A run that stops at Lemma 1
or 2 with specific step reports is still a useful result; one that passes a
step it should not is a bug to chase.

## Notation to watch

$D$ is used for three things: the division ring in $Q(R)=D[z,z^{-1};\sigma]$,
the Ore set $K[X]\setminus\{0\}$, and the spans $D_k$ in Lemmas 1 and 2. Each
claim is formalized on its own, so the formalizer has to pick the right one
from context. A faithfulness flag on these is expected, and worth reading.
