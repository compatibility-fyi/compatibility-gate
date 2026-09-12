import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("GitLab remote template", () => {
  it("defines fail-closed gate and scheduled recheck jobs", () => {
    const template = parse(
      readFileSync(resolve("gitlab/compatibility-gate.yml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;

    expect(template["compatibility.fyi/gate"]?.allow_failure).toEqual({
      exit_codes: 2,
    });
    expect(template["compatibility.fyi/gate"]?.stage).toBe(".pre");
    expect(template["compatibility.fyi/recheck"]?.allow_failure).toBe(false);
    expect(template["compatibility.fyi/recheck"]?.stage).toBe(".pre");
    for (const jobName of [
      "compatibility.fyi/gate",
      "compatibility.fyi/recheck",
    ]) {
      expect(template[jobName]?.inherit).toEqual({ default: ["tags"] });
    }
    for (const variables of [
      template.variables,
      ...Object.values(template).map((job) => job.variables),
    ]) {
      expect(variables ?? {}).not.toHaveProperty(
        "COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN",
      );
    }
  });
});
