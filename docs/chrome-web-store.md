# Chrome Web Store submission

Package: `pnpm --filter @lale/extension pack:store` → `apps/extension/release/lale-extension-<version>.zip`.
Upload at <https://chrome.google.com/webstore/devconsole>. For a pre-release set
**Visibility: Unlisted** — reviewed like any other item, but not searchable, and
installable by anyone with the link.

## Single purpose

> lale checks the mathematical claims in an Overleaf document by formalizing them
> in the Lean 4 proof assistant, using a companion app the user installs and runs
> on their own machine.

Reviewers reject vague single-purpose statements. This one is narrow and matches
what the code does.

## Short description (132 characters max)

> Formalize and check the theorems in your Overleaf paper with Lean 4 and Mathlib, from a local companion app.

## Permission justifications

Each field below maps to a box in the listing. Say what the permission is used
for, not what it grants.

| Permission | Justification |
|---|---|
| `sidePanel` | The extension's entire interface is a side panel next to the Overleaf editor: the list of claims, their status, and the log of a verification run. |
| `storage` | Stores the connection token for the local companion app and the panel's last known state, so the panel survives a browser restart. Nothing is stored remotely. |
| `tabs` | Used to find the active Overleaf project tab and send it a message when the user clicks a claim, so the editor scrolls to that claim's source. |
| `alarms` | A verification run can take several minutes with no network traffic while Lean compiles. A periodic alarm keeps the service worker alive so the run's progress stream is not dropped. |
| `https://*.overleaf.com/*` | The extension only runs on Overleaf project pages, where it reads the LaTeX source of the open document to find theorem environments. The subdomain wildcard covers Overleaf's regional and institutional hosts; the content script is still restricted to `/project/` pages. |
| `http://127.0.0.1:8765/*` | The companion app runs on the user's own machine and listens on this loopback port. All formalization and Lean checking happens there. The extension talks to no remote server of ours. |

## Data disclosures

Answer the "data usage" questions as follows, and do not understate the third:

- **Personally identifiable information**: not collected.
- **Authentication information**: not collected. (The connection token is issued
  by the user's own local app and never leaves the machine.)
- **Website content**: **collected**. The extension reads the LaTeX source of the
  Overleaf document the user has open, and sends the relevant claim and proof
  text to the local companion app. That app sends claim text to the model
  provider the user has configured (OpenRouter) under the user's own API key.
- **Not sold to third parties**, **not used for creditworthiness or lending**,
  **not used for purposes unrelated to the single purpose** — all true here.

Because "website content" is collected, a **privacy policy URL is required**. It
has to state what leaves the machine (claim and proof text, to the user's own
model provider), what does not (the document as a whole, credentials), and that
the API key is stored in the OS keychain by the companion app.

## What you still have to supply

- At least one screenshot, 1280×800 or 640×400. The side panel mid-run, next to
  an Overleaf document, is the honest shot.
- A privacy policy URL on a page you control.
- A support contact.

## Before each upload

- Bump `version` in `apps/extension/manifest.config.ts` — the store rejects a
  re-upload of an existing version.
- Rebuild and re-zip; upload `dist`, never the source tree.
