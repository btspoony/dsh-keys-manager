/**
 * Node stand-in for the `ws` package that omp's responses-WebSocket module
 * loads through a bare `require("ws")` at module scope.
 *
 * omp targets Bun: `Bun.WebSocket` is the transport, and `ws` is only the Node
 * path that inspects an HTTP upgrade response (`inspectUpgradeResponse`, set by
 * the responses WebSocket session). This plugin bundles omp's sources into a
 * Node ESM artifact, so that require must resolve at build time — and it cannot:
 * `ws` is not a dependency of omp, and Node's own `WebSocket` exposes no upgrade
 * response to inspect.
 *
 * The stand-in fails at construction, which is the branch `openai-responses`
 * already treats as "this transport cannot connect": the attempt is retried and
 * then pinned to SSE (`CONNECT_FAILURE_LIMIT`), exactly how these routes behaved
 * before 18.18.8 grew a WebSocket mode. Nothing else in the graph reads it.
 *
 * `module.exports = ` rather than an ESM default export because the call site is
 * a `require()`: esbuild hands a CommonJS module's exports back unchanged, while
 * an ESM shim arrives as a namespace object and fails with "not a constructor"
 * before this error could say why.
 *
 * shortcut: no upgrade inspection, so the responses WebSocket transport always
 * falls back to SSE; upgrade by vendoring an upgrade-inspecting Node client (or
 * by dropping that module from the graph) when a route actually needs sockets.
 *
 * @module dsh-llm-omp-transports/omp-shim/ws
 */
module.exports = class NodeWebSocketUnavailable {
  constructor() {
    throw new Error(
      'llm-omp: the bundled responses WebSocket transport needs the "ws" package for Node, which this artifact does not ship; the route stays on SSE',
    )
  }
}
