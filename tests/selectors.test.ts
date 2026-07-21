import { describe, expect, it } from "vitest";

import { resolveSelector } from "../src/selectors";
import { cluster } from "./helpers";
import { MemoryRepository } from "./helpers";

describe("resolveSelector", () => {
  it("selects matching YAML documents and extracts image versions", async () => {
    const reader = new MemoryRepository({
      head: {
        "clusters/one.yaml": `${cluster("18.4")}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ignored\n`,
        "clusters/two.yaml": cluster("17.10"),
        "other.yaml": cluster("16.7"),
      },
    });

    await expect(
      resolveSelector(reader, "head", {
        files: ["clusters/*.yaml"],
        document: {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Cluster",
        },
        value: "spec.imageName",
        extract: ":(?<version>[^@]+)$",
      }),
    ).resolves.toEqual(["18.4", "17.10"]);
  });

  it("deduplicates identical selected versions", async () => {
    const reader = new MemoryRepository({
      head: {
        "clusters/one.yaml": cluster("18.4"),
        "clusters/two.yaml": cluster("18.4"),
      },
    });

    await expect(
      resolveSelector(reader, "head", {
        files: ["clusters/**"],
        value: "spec.imageName",
        extract: ":(.*)$",
      }),
    ).resolves.toEqual(["18.4"]);
  });

  it("fails when an extract expression matches without capturing a version", async () => {
    const reader = new MemoryRepository({
      head: { "cluster.yaml": cluster("18.4") },
    });

    await expect(
      resolveSelector(reader, "head", {
        files: ["cluster.yaml"],
        value: "spec.imageName",
        extract: "18\\.4$",
      }),
    ).rejects.toThrow("must provide a named version group or capture");
  });
});
