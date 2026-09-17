import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const GrokUsageResponse = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export function grokUsageResponseToLimits(
  response: typeof GrokUsageResponse.Type,
  checkedAt: string,
) {
  const usedPercent = response.config?.creditUsagePercent;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const period = response.config?.currentPeriod;
  const periodType = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind = periodType === "WEEKLY" ? "weekly" : periodType === "MONTHLY" ? "monthly" : "other";
  const reset = period?.end ? DateTime.make(period.end) : Option.none();
  const window: ServerProviderUsageWindow = {
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

/** Account dashboard requests are not part of the local provider harness. */
export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (
  _environment?: NodeJS.ProcessEnv,
) {
  return makeUnavailableUsageLimits({
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    reason: "unsupported",
  });
});
