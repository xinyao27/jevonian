import { expect, it } from "vite-plus/test";

import {
  augmentPath,
  applyUserBinPath,
  candidateUserBinDirs,
  withAugmentedPath,
} from "./user-path";

it("lists Homebrew and local bins on unix", () => {
  const dirs = candidateUserBinDirs("darwin", "/Users/me");
  expect(dirs).toContain("/opt/homebrew/bin");
  expect(dirs).toContain("/usr/local/bin");
  expect(dirs).toContain("/Users/me/.local/bin");
});

it("prepends missing dirs onto a launchd-style PATH", () => {
  const path = augmentPath("/usr/bin:/bin:/usr/sbin:/sbin", {
    dirs: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
    delimiter: ":",
  });
  expect(path).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

it("does not duplicate dirs already present", () => {
  const path = augmentPath("/opt/homebrew/bin:/usr/bin", {
    dirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    delimiter: ":",
  });
  expect(path).toBe("/usr/local/bin:/opt/homebrew/bin:/usr/bin");
});

it("copies env with an augmented PATH and leaves other keys alone", () => {
  const next = withAugmentedPath({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/me",
  });
  expect(next.HOME).toBe("/Users/me");
  expect(next.PATH?.split(":").includes("/usr/bin")).toBe(true);
  expect(next.PATH).not.toBe("/usr/bin:/bin");
});

it("mutates process-like env in place", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const result = applyUserBinPath(env);
  expect(env.PATH).toBe(result);
  expect(result.startsWith("/usr/bin")).toBe(false);
});
