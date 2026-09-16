import { assert, describe, it } from "@effect/vitest";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

describe("sshEnvironment", () => {
  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("rejects remoting without starting an SSH runtime", () =>
    Effect.gen(function* () {
      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      assert.deepEqual(yield* sshEnvironment.discoverHosts(), []);
      const error = yield* sshEnvironment.resolveHost("example.com").pipe(Effect.flip);
      assert.equal(error._tag, "SshInvalidTargetError");
      assert.equal(error.message, "Remote environments are unavailable in the local edition.");
    }).pipe(Effect.provide(DesktopSshEnvironment.layer())),
  );
});
