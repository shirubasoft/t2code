# Telemetry-free distribution

This downstream distribution compiles telemetry out at the existing service boundaries. It does
not collect anonymous product analytics, export traces or metrics, persist local trace files, sample
host or process resources, or provision relay observability infrastructure.

Functional network traffic is unchanged. Provider CLIs, authentication, application updates, relay
connections, and push notifications still contact the services the user chooses to use. Their own
privacy behavior is outside the T3 Code telemetry boundary.

## Why the upstream interfaces remain

Telemetry call sites, contracts, and settings shapes intentionally remain type-checked. Their live
layers resolve to no-op services under the compile-time policy in
`packages/shared/src/telemetryPolicy.ts`. This keeps the privacy guarantee concentrated at stable
adapter boundaries and avoids a broad deletion patch that would conflict with routine upstream
work.

The guarded boundaries are:

- server analytics and identity creation;
- shared relay-client tracing used by server, web, and mobile;
- browser, server, desktop, and relay trace collectors and exporters;
- server and desktop resource telemetry publishers;
- relay observability infrastructure and build-time client configuration.

## Keeping the fork current

Keep the fork's `main` branch as a clean upstream mirror and rebase the telemetry-free branch as a
linear patch series:

```sh
git fetch upstream main
git rebase upstream/main feat/telemetry-free
git range-diff upstream/main...feat/telemetry-free@{1} upstream/main...feat/telemetry-free
```

Enabling `rerere` can reuse recurring conflict resolutions, but every reused resolution should be
reviewed. After each rebase, run the focused telemetry tests and search new runtime/build code for
analytics SDKs, vendor ingest hosts, tracing exporters, and resource samplers that do not pass
through the existing no-op boundaries.
