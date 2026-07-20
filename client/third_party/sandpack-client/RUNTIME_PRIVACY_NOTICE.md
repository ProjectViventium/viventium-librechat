# Sandpack runtime privacy safeguard

Viventium self-hosts the browser runtime distributed in
`@codesandbox/sandpack-client@2.19.8` instead of loading the default CodeSandbox-hosted bundler.
The package identity is pinned by `package-lock.json`; the build also verifies the exact source
index and runtime hashes before copying the runtime into `dist/sandpack-bundler/`.

Before any runtime script executes, Viventium's generated copy of `index.html` sets the upstream
on-premises environment flag `window._env_.IS_ONPREM` to `"true"`. The upstream runtime checks this
flag before its metrics request, so artifact previews do not submit CodeSandbox analytics. The
runtime JavaScript itself is not rewritten. The generated index hash and unchanged upstream runtime
hash are enforced by the build and shipped-compliance verifier.

The client requires the generated runtime to be served from a dedicated origin that differs from the
LibreChat origin. Sandpack's browser compilers use Web Workers, which need `allow-same-origin` inside
the iframe sandbox. A distinct bundler origin keeps that permission from granting artifact code
same-origin access to LibreChat. Missing, relative, non-HTTP(S), and same-origin bundler URLs fail
closed with an actionable error.

Upstream package: <https://www.npmjs.com/package/@codesandbox/sandpack-client/v/2.19.8>

Upstream source: <https://github.com/codesandbox/sandpack/tree/v2.19.8/sandpack-client>

LibreChat self-hosting reference: <https://www.librechat.ai/docs/features/artifacts#self-hosting-the-sandpack-bundler>

LibreChat CodeSandbox fork reference:
<https://github.com/LibreChat-AI/codesandbox-client/commit/5877b8427e85b457dbb4f92209b1e8a2489cfa3b>
