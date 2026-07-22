# CodeSandbox Sandpack client utility attribution

`sandpackClientAdapter.ts` adapts utility functions from
`@codesandbox/sandpack-client` 2.19.8. The upstream work is Copyright 2022 CodeSandbox BV and is
licensed under the Apache License, Version 2.0. Viventium changed the module boundary and client
routing to exclude the Nodebox implementation and the notice-incomplete static-browser-server
dependency from its browser bundle. Static and browser-runtime artifacts both use SandpackRuntime.

The upstream source is available at <https://github.com/codesandbox/sandpack>. A complete copy of
the applicable Apache-2.0 license and the upstream copyright notice is tracked at
[`client/third_party/sandpack-client/LICENSE.txt`](../../third_party/sandpack-client/LICENSE.txt).
The dependency also distributes its original `@codesandbox/sandpack-client/LICENSE` file.
