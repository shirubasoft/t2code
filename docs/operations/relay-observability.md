# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

This distribution does not provision an observability backend or export relay traces. The relay
keeps native in-memory span IDs only where application error contracts require correlation IDs;
those spans have no exporter or persistent sink.

Relay deployments require Cloudflare and PlanetScale credentials only. No analytics or tracing
credential is read, generated, stored, attached to the Worker, or passed to client builds.

For operational debugging, use direct Cloudflare Worker logs and the functional service health
checks. See [Telemetry-free distribution](../internals/telemetry-free-distribution.md) for the
privacy boundary and rebase workflow.
