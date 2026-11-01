// @effect-diagnostics globalDate:off globalFetch:off - bootstrap has no Effect dependencies.
// @effect-diagnostics nodeBuiltinImport:off - standalone collector installed outside the checkout.
import * as NodeOS from "node:os";

export interface SummaryEvent {
  id: string;
  recordedAt: number;
  host: string;
  platform: string;
  arch: string;
  ci: boolean;
  runId: string;
  tasks: {
    package: string;
    task: string;
    source: "local" | "remote" | "unspecified" | "executed" | "failed";
    savedMs: number;
  }[];
}

export function summarize(value: unknown): SummaryEvent["tasks"] {
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks))
    return [];
  return value.tasks.flatMap((task: unknown) => {
    if (
      !task ||
      typeof task !== "object" ||
      !("package_name" in task) ||
      !("task_name" in task) ||
      !("result" in task)
    )
      return [];
    if (
      typeof task.package_name !== "string" ||
      typeof task.task_name !== "string" ||
      !task.result ||
      typeof task.result !== "object"
    )
      return [];
    let source: SummaryEvent["tasks"][number]["source"] = "executed";
    let savedMs = 0;
    if ("CacheHit" in task.result) {
      const hit = task.result.CacheHit;
      if (
        !hit ||
        typeof hit !== "object" ||
        !("saved_duration_ms" in hit) ||
        typeof hit.saved_duration_ms !== "number" ||
        !Number.isSafeInteger(hit.saved_duration_ms) ||
        hit.saved_duration_ms < 0
      )
        return [];
      if ("source" in hit && hit.source !== "Local" && hit.source !== "Remote") return [];
      source = !("source" in hit) ? "unspecified" : hit.source === "Remote" ? "remote" : "local";
      savedMs = hit.saved_duration_ms;
    } else if ("RestoreFailed" in task.result) source = "failed";
    else if (!("Spawned" in task.result)) return [];
    else if (
      task.result.Spawned &&
      typeof task.result.Spawned === "object" &&
      "cache_status" in task.result.Spawned &&
      task.result.Spawned.cache_status === "Disabled"
    )
      return [];
    return [
      {
        package: task.package_name.slice(0, 256),
        task: task.task_name.slice(0, 256),
        source,
        savedMs,
      },
    ];
  });
}

export function observeSummaries(
  _root: string,
  _endpoint: string,
  _env: NodeJS.ProcessEnv,
  _home = NodeOS.homedir(),
) {
  // Vite keeps local task summaries; this distribution never queues external diagnostics.
  return () => {};
}

export async function flushTelemetry(_home = NodeOS.homedir(), _env = process.env) {
  // Installed outside the workspace; external diagnostic delivery is disabled here too.
}
