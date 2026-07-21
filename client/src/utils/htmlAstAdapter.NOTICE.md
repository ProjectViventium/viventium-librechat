# Viventium html-parse-stringify adapter attribution

`htmlAstAdapter.ts` is a modified browser-build compatibility implementation derived from
`html-parse-stringify`.

- Upstream repository: <https://github.com/henrikjoreteg/html-parse-stringify>
- Locked upstream package: `html-parse-stringify@3.0.1`
- Upstream package revision: `ce46022f537ef9b050fac592f9fcc30bf838e5ba`
- Locked package integrity: `sha512-KknJ50kTInJ7qIScF3jeaFRpMpE8/lfiTdzf/twXyPBLAGrLRTmkz3AdTnKeh40X8k9L2fdYwEp/42WGXIRGcg==`
- Upstream license record: `LICENSE` added on the official `release-3.1.0` branch at commit `a2659e6eac3603ba8b46958e0bd35b337108261f`
- License: MIT

The official `v3.0.1` tag predates the exact package revision and the repository's standalone
license file. The adapter is therefore bound to the exact published package identity above, while
its copyright and license text are pinned independently to the official upstream repository.
Viventium replaced the runtime dependency with the parsing and stringifying surface required by
the browser-only release build.
