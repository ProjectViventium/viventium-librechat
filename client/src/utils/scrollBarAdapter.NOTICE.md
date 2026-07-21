# Viventium react-remove-scroll-bar adapter attribution

`scrollBarAdapter.tsx` is a modified browser-build compatibility implementation derived from
`react-remove-scroll-bar`.

- Upstream repository: <https://github.com/theKashey/react-remove-scroll-bar>
- Locked upstream package: `react-remove-scroll-bar@2.3.8`
- Locked package integrity: `sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==`
- Upstream license record: `LICENSE` at commit `8ca9ba5ea52de03308fe8ced94f7b159a44d28ff`
- License: MIT

The upstream repository does not publish a `v2.3.8` tag. The adapter is therefore bound to the
exact npm package identity above, while its copyright and license text are pinned independently to
the official upstream repository. Viventium replaced runtime style injection dependencies with a
small local implementation suitable for the browser-only release build.
