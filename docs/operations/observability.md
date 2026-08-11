# Observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

This distribution keeps direct application and terminal logs, but compiles out telemetry:

- no product analytics or installation identifier;
- no local trace files or browser trace ingestion;
- no OTLP trace or metric exporters;
- no desktop or server resource sampling;
- no relay observability backend.

Native in-memory span IDs remain only where application and relay error contracts use them for
request correlation. They have no exporter or persistent sink. Provider event files and explicit
terminal output are functional debugging artifacts, not telemetry collected by T3 Code.

The Diagnostics UI reports trace and resource telemetry as unavailable. See
[Telemetry-free distribution](../internals/telemetry-free-distribution.md) for the complete boundary
and the downstream rebase workflow.
