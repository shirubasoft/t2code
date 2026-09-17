import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PullRequestActorAvatar } from "./pullRequestPresentation";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  "https://ghe.example/octocat.png",
  "https://avatars.githubusercontent.com/u/1",
  "//ghe.example/octocat.png",
  null,
])("renders an initial without loading avatar %s", async (avatarUrl) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn(() => {
    throw new Error("Avatar rendering must not request remote assets.");
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    renderer = create(
      <PullRequestActorAvatar actor={{ login: "octocat", name: null, avatarUrl }} />,
    );
  });

  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(renderer!.root.findByType("span").children).toEqual(["O"]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps deleted actors readable without an avatar", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<PullRequestActorAvatar actor={null} />);
  });
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(renderer!.root.findByType("span").children).toEqual(["G"]);
});
