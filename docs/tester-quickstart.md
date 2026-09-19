# lale — tester quick start

Thanks for trying this. It checks the theorems in an Overleaf paper by
formalizing them in Lean 4. Setup is three installs and one long download.

**You need:** a Mac with Apple Silicon, about 11 GB free, and an OpenRouter
account with credit on it (you will use your own key; expect $0.20-$2 per claim).

---

## 1. Install the app (2 minutes)

Open `lale-0.1.0-arm64.dmg` and drag **lale** to Applications.

The app is not signed yet, so the first launch is blocked. Open it once, let
macOS refuse, then go to **System Settings → Privacy & Security**, scroll to the
message about lale, and click **Open Anyway**.

You will get a menu-bar icon, no window and no dock icon. That icon is the app.
Its menu shows the version and whether the service is running.

## 2. Install the extension (2 minutes)

Unzip `lale-extension-0.1.0.zip`, then in Chrome:

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose the unzipped folder
4. Pin lale to the toolbar if you want it handy

Chrome will occasionally warn you about developer-mode extensions. That is
expected for a pre-release.

## 3. Connect (10 seconds)

Open any Overleaf project, click the lale icon, and press **Connect** in the
panel. The app will ask you to approve; click **Allow**. There is no token to
copy.

## 4. Add your model key (1 minute)

In the panel, open **Settings** and paste an OpenRouter API key. It is stored in
your macOS keychain by the app, never in the browser.

## 5. Install Lean (20-40 minutes, once)

Still in **Settings**, start provisioning. This downloads about 1 GB, which
expands to roughly 11 GB: the Lean toolchain into `~/.elan`, and Mathlib with its
prebuilt libraries into `~/.lale/lean-project`. Most of the time is spent
decompressing, so it is slower than the download size suggests.

You can close the panel; it keeps going. When it finishes the panel reports Lean
as available.

---

## Using it

Open a project whose LaTeX has `\begin{theorem}` / `\begin{lemma}` /
`\begin{definition}` environments, ideally with `\label{...}` on each. The panel
lists what it found. Click a claim and you get three choices (two, for a claim
with no proof block — there is nothing to check the steps of):

- **Formalize only** — states the claim in Lean and checks the formalization says
  what your prose says. No proof attempt. Cheapest, and the best first move.
- **Check proof steps** — splits *your* proof into steps, states each in Lean and
  tries to prove each. This is the one that audits your argument, and it tells
  you *which step* fails.
- **Verify** — formalizes the statement and asks a model to prove the theorem.
  A pass means the theorem is true; it does not mean your proof was read.

Claims that cite other claims (`\ref{lem:foo}`) need those verified first — you
will get `dependencyMissing` otherwise. Work upwards from the bottom of your
dependency chain.

## Reading the outcomes

These are all of them; nothing else is ever reported.

| Outcome | Meaning |
|---|---|
| `verified` | Lean accepted a proof, with no `sorry` and no unexpected axioms. |
| `formalized` | The statement (or every proof step) was stated in Lean successfully. |
| `proofIncomplete` | A step could not be stated or proved, or the proof attempts ran out. The log names which. |
| `malformedClaim` | The statement itself would not type-check in Lean after several attempts. Usually the prose is ambiguous about types or quantifiers. |
| `malformedProof` | A proof was asked for and the claim has no adjacent `\begin{proof}` block. |
| `formalizationUnfaithful` | The Lean version does not say what your prose says. The log gives the judge's reason — usually a real ambiguity in the writing. |
| `proofDoesNotSupportClaim` | Lean accepted a proof, but the formalization it proved did not clear the faithfulness gate — so the pass does not transfer to your claim. |
| `dependencyMissing` | A referenced claim has not been verified yet. |
| `verificationBlocked` | Something environmental: no credit, no Lean, a dropped connection, a run budget spent. The log says which. |

Note the distinction between the two failure families. `proofIncomplete` and
`malformedClaim` are about the mathematics and are worth reading.
`dependencyMissing` and `verificationBlocked` are about the run, and say nothing
about your paper.

## What it is good at, and what it is not

It is genuinely good at finding **imprecision**: an unstated hypothesis, a term
used two ways, a definition that omits a case. Those are found by formalizing,
which is cheap.

It is limited at **proving**, and honestly so. A model writes a candidate proof
and Lean judges it; there is no proof search. Claims whose content is arithmetic
or finite case analysis often go through. Claims needing mathematical theory that
Mathlib does not have will formalize and then fail to prove — that is expected,
not a bug in your paper.

## When something goes wrong

Send two things:

1. The version from the menu bar (`lale 0.1.0 — …`).
2. The log: menu → **Open log**, or `~/Library/Logs/lale/desktop.log`.

The log holds the run history and the whole provisioning transcript. It contains
your document's claim text; it does not contain your API key.

## Uninstalling

Quit from the menu, drag the app to the Trash, and remove `~/.lale` (the database
and Lean project), `~/.elan` (the toolchain) and `~/Library/Logs/lale`. The
keychain entry is under service `lale`.
