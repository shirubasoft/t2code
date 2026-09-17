import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";

/** Account dashboard requests are not part of the local provider harness. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (_input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  return makeUnavailableUsageLimits({
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    reason: "unsupported",
  });
});
