import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const actionPath = resolve("dist/index.js");

describe("compiled action", () => {
  it("boots without unresolved bundled modules", () => {
    const bundle = readFileSync(actionPath, "utf8");
    expect(bundle).not.toContain("webpackMissingModule");

    const result = spawnSync(process.execPath, [actionPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        "INPUT_GITHUB-TOKEN": "",
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain("Cannot find module");
    expect(output).toContain("Input required and not supplied: github-token");
  });
});
