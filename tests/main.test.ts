import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStatus: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  addRaw: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string) =>
    ({ "github-token": "token", mode: "current" })[name],
  info: vi.fn(),
  warning: vi.fn(),
  setOutput: mocks.setOutput,
  setFailed: mocks.setFailed,
  summary: { addRaw: mocks.addRaw },
}));
vi.mock("../src/github.js", () => ({
  GitHubClient: class {
    getDefaultBranch = vi.fn().mockResolvedValue("master");
    createStatus = mocks.createStatus;
  },
}));
vi.mock("../src/git.js", () => ({ GitRepositoryReader: class {} }));
vi.mock("../src/runner.js", () => ({
  prepareGate: vi.fn().mockResolvedValue({}),
  evaluateConfiguredBranch: mocks.evaluate,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("GitHub action summary", () => {
  it.each([
    {
      name: "tested",
      basis: "tested",
      compatible: "compatible",
      range: ">=14 <19",
      expectedBasis: "tested",
      expectedRange: ">=14 <19",
    },
    {
      name: "legacy supported",
      compatible: "compatible",
      range: ">=14 <19",
      expectedBasis: "supported",
      expectedRange: ">=14 <19",
    },
    {
      name: "unknown without evidence",
      basis: null,
      compatible: "unknown",
      range: null,
      expectedBasis: "—",
      expectedRange: "—",
    },
    {
      name: "exact version",
      basis: "supported",
      compatible: "compatible",
      range: null,
      matchedConstraint: "same-version",
      expectedBasis: "supported",
      expectedRange: "Same exact version",
    },
  ])("reports $name evidence accurately", async (testCase) => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    vi.stubEnv("GITHUB_REF_NAME", "renovate/database");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    mocks.addRaw.mockReturnValue({
      write: vi.fn().mockResolvedValue(undefined),
    });
    const compatible = testCase.compatible === "compatible";
    const state = compatible ? "success" : "error";
    const confidence = compatible ? "high" : "low";
    const verified = compatible ? "2026-09-11" : null;
    const projectVersion = testCase.matchedConstraint ? "18.4" : "13.2";
    mocks.evaluate.mockResolvedValue({
      branch: "renovate/database",
      sha: "a".repeat(40),
      state,
      description: compatible
        ? "1 compatibility check passed"
        : "Unknown compatibility blocked",
      gates: [
        {
          gateId: "database",
          applicable: true,
          decisions: [
            {
              gateId: "database",
              project: "grafana",
              projectVersion,
              dependency: "postgresql",
              dependencyVersion: "18.4",
              state,
              message: compatible
                ? "Database compatibility established"
                : "Unknown compatibility blocked",
              response: {
                project: "grafana",
                version: projectVersion,
                dependency: "postgresql",
                dependencyVersion: "18.4",
                compatible: testCase.compatible,
                basis: testCase.basis,
                matchedRange: testCase.range,
                matchedConstraint: testCase.matchedConstraint ?? null,
                relationship: null,
                confidence,
                lastVerified: verified,
                notes: [],
                sources: compatible
                  ? [
                      {
                        title: "Compatibility matrix",
                        url: "https://example.com/matrix",
                        accessedAt: "2026-09-11",
                      },
                    ]
                  : [],
              },
            },
          ],
        },
      ],
    });

    await import("../src/main.js");
    await vi.waitFor(() =>
      expect(mocks.setOutput).toHaveBeenCalledWith(
        "result",
        compatible ? "success" : "blocked",
      ),
    );
    const markdown = mocks.addRaw.mock.calls[0]?.[0] as string;
    expect(markdown).toContain("| Range | Basis | Confidence | Verified |");
    expect(markdown).toContain(
      `| ${testCase.expectedRange} | ${testCase.expectedBasis} | ${confidence} | ${verified ?? "—"} |`,
    );
    expect(mocks.setFailed).not.toHaveBeenCalled();
  });
});
