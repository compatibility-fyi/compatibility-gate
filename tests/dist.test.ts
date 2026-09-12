import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("compiled entry points", () => {
  it.each([
    [
      "action",
      "dist/index.js",
      "Input required and not supplied: github-token",
    ],
    ["GitLab CLI", "dist/cli.js", "CI_COMMIT_BRANCH is required"],
  ])(
    "boots the %s without repository dependencies",
    (_name, source, expectedError) => {
      const directory = mkdtempSync(join(tmpdir(), "compatibility-gate-dist-"));
      try {
        const bundle = join(directory, "entry.mjs");
        copyFileSync(resolve(source), bundle);
        const result = spawnSync(process.execPath, [bundle], {
          cwd: directory,
          encoding: "utf8",
          env: {},
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
