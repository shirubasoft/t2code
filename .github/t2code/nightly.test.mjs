import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { nightlyVersion, selectNightly, publishedNightly } from "./nightly.mjs";

const release = (id, options = {}) => ({
  id,
  tag_name: `v0.0.43-nightly.20260917.${id}`,
  draft: false,
  prerelease: true,
  published_at: `2026-09-17T${String(id).padStart(2, "0")}:00:00Z`,
  ...options,
});
NodeTest.test(
  "bootstrap follows the newest published nightly, ignoring main, stable, previews and drafts",
  () => {
    const latest = release(3);
    NodeAssert.equal(
      selectNightly(
        [
          release(8, { tag_name: "main" }),
          release(7, { tag_name: "v0.0.44" }),
          release(6, { tag_name: "v0.0.43-preview.20260917.6" }),
          release(5, { draft: true }),
          release(4, { published_at: null }),
          latest,
          release(1),
          release(2),
        ],
        { commit: "a".repeat(40) },
      ),
      latest,
    );
  },
);
NodeTest.test("backlogs follow publication order and do not skip intermediate nightlies", () => {
  const first = release(1),
    second = release(2),
    third = release(3);
  NodeAssert.equal(
    selectNightly([third, first, second], { tag: first.tag_name, releaseId: 1 }),
    second,
  );
  NodeAssert.equal(
    selectNightly([third, first, second], { tag: second.tag_name, releaseId: 2 }),
    third,
  );
  NodeAssert.equal(
    selectNightly([third, first, second], { tag: third.tag_name, releaseId: 3 }),
    undefined,
  );
});
NodeTest.test("removed and recreated upstream releases fail closed", () => {
  NodeAssert.throws(
    () => selectNightly([release(2)], { tag: release(1).tag_name, releaseId: 1 }),
    /removed or replaced/,
  );
  NodeAssert.throws(
    () => selectNightly([release(2)], { tag: release(2).tag_name, releaseId: 1 }),
    /removed or replaced/,
  );
});
NodeTest.test("only exact nightly version tags can be published", () => {
  NodeAssert.equal(nightlyVersion("v0.0.43-nightly.20260917.1866"), "0.0.43-nightly.20260917.1866");
  for (const tag of [
    "main",
    "v0.1.42",
    "v0.0.43-preview.20260917.1866",
    "v0.0.43-nightly.20260917.1866\nsha=other",
    undefined,
  ])
    NodeAssert.throws(() => nightlyVersion(tag), /nightly version tag/);
  NodeAssert.equal(publishedNightly(release(1, { prerelease: false })), false);
});
