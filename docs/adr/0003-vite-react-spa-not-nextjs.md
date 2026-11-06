---
status: accepted
---

# Build the client as a Vite + React single-page app, not Next.js

The client is a statically built, content-hashed single-page app. Constitution VII needs a CSP without `unsafe-inline`, a pinned asset manifest and reproducible builds, and IX needs a minimal dependency tree; Next.js's server rendering, inline bootstrap scripts and larger dependency tree work against all three.

## Considered Options

- Next.js with `output: 'export'`: the fallback, at the cost of per-build CSP hashes for its inline scripts.
- SvelteKit static: smaller output, but React was the preferred UI library.
