import type { CursorSettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const CursorUsageResponse = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const [key, label] of [
      ["totalPercentUsed", "Monthly"],
      ["autoPercentUsed", "Monthly · Auto"],
      ["apiPercentUsed", "Monthly · API"],
    ] as const) {
      const usedPercent = response.planUsage[key];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id: key,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

/** Account dashboard requests are not part of the local provider harness. */
export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  _settings: Pick<CursorSettings, "apiEndpoint">,
  _environment?: NodeJS.ProcessEnv,
) {
  return makeUnavailableUsageLimits({
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    reason: "unsupported",
  });
});
