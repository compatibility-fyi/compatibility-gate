import { describe, expect, it, vi } from "vitest";

import type { CompatibilityCheckRequest } from "../src/api.js";
import { parseConfiguration } from "../src/config.js";
import { evaluateBranch } from "../src/evaluate.js";
import type { CompatibilityCheckResponse } from "../src/types.js";
import {
  cluster,
  configurationYaml,
  MemoryRepository,
  operator127,
  operator130,
} from "./helpers.js";

function response(
  overrides: Partial<CompatibilityCheckResponse> = {},
): CompatibilityCheckResponse {
  return {
    project: "cloudnativepg",
    version: "v1.27.0",
    dependency: "postgresql",
    dependencyVersion: "18.4",
    compatible: "compatible",
    matchedRange: ">=13.0.0 <19.0.0",
    relationship: "operand",
    confidence: "high",
    lastVerified: "2026-07-08",
    notes: [],
    sources: [
      {
        title: "CloudNativePG release notes",
        url: "https://cloudnative-pg.io/",
        accessedAt: "2026-07-08",
      },
    ],
    ...overrides,
  };
}

describe("evaluateBranch", () => {
  it.each(["recommended", "bundled"] as const)(
    "blocks unknown %s evidence even when its range matches",
    async (basis) => {
      const checker = {
        check: vi
          .fn()
          .mockResolvedValue(response({ compatible: "unknown", basis })),
      };
      const result = await evaluateBranch(
        "renovate/postgresql",
        "head",
        "base",
        repository(operator127, "17.10", operator127, "18.4"),
        parseConfiguration(configurationYaml),
        checker,
      );
      expect(result.state).toBe("error");
      expect(result.description).toContain(
        `${basis} evidence does not establish compatibility`,
      );
    },
  );

  it("reports tested coverage without claiming upstream support", async () => {
    const checker = {
      check: vi.fn().mockResolvedValue(response({ basis: "tested" })),
    };
    const result = await evaluateBranch(
      "renovate/postgresql",
      "head",
      "base",
      repository(operator127, "17.10", operator127, "18.4"),
      parseConfiguration(configurationYaml),
      checker,
    );
    expect(result.state).toBe("success");
    expect(result.description).toContain("was tested with postgresql 18.4");
  });

  it("blocks an incompatible dependency update", async () => {
    const reader = repository(operator127, "17.10", operator127, "18.4");
    const checker = {
      check: vi
        .fn()
        .mockResolvedValue(
          response({ compatible: "incompatible", matchedRange: null }),
        ),
    };

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "a".repeat(40),
      "base",
      reader,
      parseConfiguration(configurationYaml),
      checker,
    );

    expect(result.state).toBe("failure");
    expect(result.description).toContain("does not support postgresql 18.4");
    expect(checker.check).toHaveBeenCalledWith({
      project: "cloudnativepg",
      version: "v1.27.0",
      dependency: "postgresql",
      dependencyVersion: "18.4",
    });
  });

  it("uses the proposed project and dependency versions for grouped updates", async () => {
    const reader = repository(operator127, "17.10", operator130, "18.4");
    const checker = {
      check: vi.fn().mockResolvedValue(
        response({
          version: "v1.30.0",
          compatible: "compatible",
          matchedRange: ">=14.0.0 <19.0.0",
        }),
      ),
    };

    const result = await evaluateBranch(
      "renovate/cnpg-and-postgresql",
      "b".repeat(40),
      "base",
      reader,
      parseConfiguration(configurationYaml),
      checker,
    );

    expect(result.state).toBe("success");
    expect(checker.check).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "v1.30.0",
        dependencyVersion: "18.4",
      }),
    );
  });

  it("combines applicable gates and blocks when any relationship fails", async () => {
    const reader = new MemoryRepository({
      base: { "versions.yaml": "project: '1'\ndatabase: '17'\nruntime: '21'" },
      head: { "versions.yaml": "project: '2'\ndatabase: '18'\nruntime: '25'" },
    });
    const configuration = parseConfiguration(configurationYaml);
    const policy = configuration.gates[0]!.policy;
    configuration.gates = ["database", "runtime"].map((dependency) => ({
      id: `sample-${dependency}`,
      project: {
        id: "sample",
        version: { files: ["versions.yaml"], value: "project" },
      },
      dependency: {
        id: dependency,
        versions: { files: ["versions.yaml"], value: dependency },
      },
      policy,
    }));
    const checker = {
      check: vi.fn((request: CompatibilityCheckRequest) =>
        Promise.resolve(
          response({
            ...request,
            compatible:
              request.dependency === "runtime" ? "incompatible" : "compatible",
            matchedRange: request.dependencyVersion,
          }),
        ),
      ),
    };
    const result = await evaluateBranch(
      "renovate/grouped",
      "head",
      "base",
      reader,
      configuration,
      checker,
    );
    expect(checker.check.mock.calls.map(([request]) => request)).toEqual([
      {
        project: "sample",
        version: "2",
        dependency: "database",
        dependencyVersion: "18",
      },
      {
        project: "sample",
        version: "2",
        dependency: "runtime",
        dependencyVersion: "25",
      },
    ]);
    expect(
      result.gates.flatMap((gate) =>
        gate.decisions.map((decision) => decision.state),
      ),
    ).toEqual(["success", "failure"]);
    expect(result.state).toBe("failure");
    expect(result.description).toContain("does not support runtime 25");
  });

  it("returns success without an API call for unrelated branches", async () => {
    const reader = repository(operator127, "17.10", operator127, "17.10");
    const checker = { check: vi.fn() };

    const result = await evaluateBranch(
      "renovate/unrelated",
      "c".repeat(40),
      "base",
      reader,
      parseConfiguration(configurationYaml),
      checker,
    );

    expect(result.state).toBe("success");
    expect(result.description).toBe("No configured compatibility gate applies");
    expect(checker.check).not.toHaveBeenCalled();
  });

  it("blocks unknown compatibility by default", async () => {
    const reader = repository(operator127, "17.10", operator127, "18.4");
    const checker = {
      check: vi.fn().mockResolvedValue(
        response({
          compatible: "unknown",
          matchedRange: null,
          confidence: "low",
        }),
      ),
    };

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "d".repeat(40),
      "base",
      reader,
      parseConfiguration(configurationYaml),
      checker,
    );

    expect(result.state).toBe("error");
    expect(result.description).toContain("unknown compatibility blocked");
  });

  it("warns without blocking when unknown compatibility uses warn policy", async () => {
    const reader = repository(operator127, "17.10", operator127, "18.4");
    const checker = {
      check: vi.fn().mockResolvedValue(
        response({
          compatible: "unknown",
          matchedRange: null,
          confidence: "low",
        }),
      ),
    };
    const configuration = parseConfiguration(
      `${configurationYaml}\ndefaults:\n  unknown: warn\n`,
    );

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "4".repeat(40),
      "base",
      reader,
      configuration,
      checker,
    );

    expect(result.state).toBe("warning");
    expect(result.description).toContain("unknown compatibility warning");
  });

  it("warns without blocking when an API error uses warn policy", async () => {
    const reader = repository(operator127, "17.10", operator127, "18.4");
    const checker = {
      check: vi.fn().mockRejectedValue(new Error("service unavailable")),
    };
    const configuration = parseConfiguration(
      `${configurationYaml}\ndefaults:\n  apiError: warn\n`,
    );

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "5".repeat(40),
      "base",
      reader,
      configuration,
      checker,
    );

    expect(result.state).toBe("warning");
    expect(result.description).toContain("API error warning");
  });

  it("reports a blocking result when another decision only warns", async () => {
    const reader = new MemoryRepository({
      base: {
        "operator.yaml": operator127,
        "clusters/one.yaml": cluster("17.10"),
      },
      head: {
        "operator.yaml": operator127,
        "clusters/one.yaml": cluster("18.3"),
        "clusters/two.yaml": cluster("18.4"),
      },
    });
    const checker = {
      check: vi
        .fn()
        .mockResolvedValueOnce(
          response({ compatible: "unknown", matchedRange: null }),
        )
        .mockResolvedValueOnce(
          response({ compatible: "incompatible", matchedRange: null }),
        ),
    };
    const configuration = parseConfiguration(
      `${configurationYaml}\ndefaults:\n  unknown: warn\n`,
    );

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "6".repeat(40),
      "base",
      reader,
      configuration,
      checker,
    );

    expect(result.state).toBe("failure");
    expect(result.description).toContain("does not support postgresql 18.4");
  });

  it("enforces evidence freshness when configured", async () => {
    const reader = repository(operator127, "17.10", operator127, "18.4");
    const checker = { check: vi.fn().mockResolvedValue(response()) };
    const configuration = parseConfiguration(
      configurationYaml.replace(
        "        extract: ':(?<version>[^@]+)$'",
        () =>
          "        extract: ':(?<version>[^@]+)$'\n    policy:\n      maximumEvidenceAgeDays: 30",
      ),
    );

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "e".repeat(40),
      "base",
      reader,
      configuration,
      checker,
      new Date("2026-08-20T00:00:00Z"),
    );

    expect(result.state).toBe("failure");
    expect(result.description).toContain("43 days old");
  });

  it("checks every resulting dependency version and blocks if any one fails", async () => {
    const reader = new MemoryRepository({
      base: {
        "operator.yaml": operator127,
        "clusters/one.yaml": cluster("17.10"),
        "clusters/two.yaml": cluster("17.9"),
      },
      head: {
        "operator.yaml": operator127,
        "clusters/one.yaml": cluster("18.4"),
        "clusters/two.yaml": cluster("17.9"),
      },
    });
    const checker = {
      check: vi
        .fn()
        .mockImplementation(
          ({ dependencyVersion }: { dependencyVersion: string }) =>
            Promise.resolve(
              response({
                dependencyVersion,
                compatible: dependencyVersion.startsWith("18")
                  ? "incompatible"
                  : "compatible",
                matchedRange: dependencyVersion.startsWith("18")
                  ? null
                  : ">=13.0.0 <18.0.0",
              }),
            ),
        ),
    };

    const result = await evaluateBranch(
      "renovate/postgresql-18.x",
      "f".repeat(40),
      "base",
      reader,
      parseConfiguration(configurationYaml),
      checker,
    );

    expect(result.state).toBe("failure");
    expect(checker.check).toHaveBeenCalledTimes(2);
  });
});

function repository(
  baseOperator: string,
  basePostgresql: string,
  headOperator: string,
  headPostgresql: string,
): MemoryRepository {
  return new MemoryRepository({
    base: {
      "operator.yaml": baseOperator,
      "clusters/database.yaml": cluster(basePostgresql),
    },
    head: {
      "operator.yaml": headOperator,
      "clusters/database.yaml": cluster(headPostgresql),
    },
  });
}
