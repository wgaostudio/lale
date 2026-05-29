# Reference Notes

The previous repo at `/Users/willgao/Desktop/lale` is the reference implementation.

Code worth preserving:

- `packages/extension/public/main-world.js`
- `packages/extension/src/content/index.ts`, specifically the request/reply bridge to the injected main-world script

Known product decision:

- Keep the free product local-first.
- The extension should talk to a desktop companion server on localhost.
- Lean execution, cache storage, logs, and user-owned model keys belong in the desktop app.

Known translation decision:

- Do not copy the old autoformalization pipeline by default.
- Build translation quality through `evals/` before wiring it into the main extension flow.

