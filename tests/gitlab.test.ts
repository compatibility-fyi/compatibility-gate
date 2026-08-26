import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type GateLogger,
  runGitLabGate,
  runGitLabRecheck,
} from "../src/gitlab.js";
import { cluster, configurationYaml, operator127 } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitLab compatibility gate", () => {
  it("loads policy from the default branch and blocks unknown compatibility", async () => {
    const fixture = createRepositoryFixture(true);
    await withCompatibilityApi("unknown", async (apiUrl) => {
      const logs = captureLogs();
      const exitCode = await runGitLabGate(
        {
          CI_COMMIT_BRANCH: fixture.branch,
          CI_COMMIT_SHA: fixture.sha,
          CI_DEFAULT_BRANCH: "master",
          COMPATIBILITY_FYI_API_URL: apiUrl,
        },
        logs.logger,
        fixture.repository,
      );

      expect(exitCode).toBe(1);
      expect(logs.errors.join("\n")).toContain("unknown compatibility blocked");
    });
  });

  it("passes a compatible proposed repository state", async () => {
    const fixture = createRepositoryFixture(false);
    await withCompatibilityApi("compatible", async (apiUrl) => {
      const logs = captureLogs();
      const exitCode = await runGitLabGate(
        {
          CI_COMMIT_BRANCH: fixture.branch,
          CI_COMMIT_SHA: fixture.sha,
          CI_DEFAULT_BRANCH: "master",
          COMPATIBILITY_FYI_API_URL: apiUrl,
        },
        logs.logger,
        fixture.repository,
      );

      expect(exitCode).toBe(0);
      expect(logs.infos.join("\n")).toContain(
        "cloudnativepg v1.27.0 supports postgresql 18.4",
      );
    });
  });

  it("returns the non-blocking warning exit code for warn policy", async () => {
    const fixture = createRepositoryFixture(
      false,
      `${configurationYaml}\ndefaults:\n  unknown: warn\n`,
    );
    await withCompatibilityApi("unknown", async (apiUrl) => {
      const logs = captureLogs();
      const exitCode = await runGitLabGate(
        {
          CI_COMMIT_BRANCH: fixture.branch,
          CI_COMMIT_SHA: fixture.sha,
          CI_DEFAULT_BRANCH: "master",
          COMPATIBILITY_FYI_API_URL: apiUrl,
        },
        logs.logger,
        fixture.repository,
      );

      expect(exitCode).toBe(2);
      expect(logs.warnings.join("\n")).toContain(
        "unknown compatibility warning",
      );
      expect(logs.errors).toEqual([]);
    });
  });

  it("returns success without reading configuration for unrelated branches", async () => {
    const logs = captureLogs();
    const exitCode = await runGitLabGate(
      { CI_COMMIT_BRANCH: "feature/readme" },
      logs.logger,
    );

    expect(exitCode).toBe(0);
    expect(logs.infos).toEqual([
      "No compatibility gate applies to branch feature/readme",
    ]);
  });
});

describe("GitLab scheduled recheck", () => {
  it("paginates branches and triggers matching Renovate pipelines", async () => {
    const triggered: Array<{ ref: string; token: string }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: index === 17 ? "renovate/postgresql-18.x" : `feature/${index}`,
    }));
    const fetchMock: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/repository/branches")) {
        expect(new Headers(init?.headers).get("JOB-TOKEN")).toBe("job-token");
        const page = url.searchParams.get("page");
        return Promise.resolve(
          Response.json(
            page === "1" ? firstPage : [{ name: "renovate/gitlab-helm-10.x" }],
          ),
        );
      }
      if (url.pathname.endsWith("/trigger/pipeline")) {
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("Expected URL-encoded trigger body");
        }
        const body = init.body;
        triggered.push({
          ref: body.get("ref") ?? "",
          token: body.get("token") ?? "",
        });
        return Promise.resolve(Response.json({ id: 123 }, { status: 201 }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    };
    const logs = captureLogs();

    const exitCode = await runGitLabRecheck(
      {
        CI_API_V4_URL: "https://gitlab.example/api/v4",
        CI_PROJECT_ID: "42",
        CI_JOB_TOKEN: "job-token",
        COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN: "trigger-secret",
      },
      logs.logger,
      fetchMock,
    );

    expect(exitCode).toBe(0);
    expect(triggered).toEqual([
      { ref: "renovate/postgresql-18.x", token: "trigger-secret" },
      { ref: "renovate/gitlab-helm-10.x", token: "trigger-secret" },
    ]);
    expect(`${logs.infos.join("\n")}\n${logs.errors.join("\n")}`).not.toContain(
      "trigger-secret",
    );
  });

  it("fails closed when GitLab rejects branch listing", async () => {
    const logs = captureLogs();
    const fetchMock: typeof fetch = () =>
      Promise.resolve(Response.json({}, { status: 403 }));

    const exitCode = await runGitLabRecheck(
      {
        CI_API_V4_URL: "https://gitlab.example/api/v4",
        CI_PROJECT_ID: "42",
        CI_JOB_TOKEN: "job-token",
        COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN: "trigger-secret",
      },
      logs.logger,
      fetchMock,
    );

    expect(exitCode).toBe(1);
    expect(logs.errors).toEqual([
      "Compatibility recheck error: GitLab branch API returned HTTP 403",
    ]);
  });
});

function createRepositoryFixture(
  branchChangesPolicy: boolean,
  defaultBranchConfiguration = configurationYaml,
): {
  repository: string;
  branch: string;
  sha: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "compatibility-gate-gitlab-"));
  temporaryDirectories.push(root);
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["clone", "--quiet", remote, repository]);
  git(repository, ["config", "user.email", "test@compatibility.fyi"]);
  git(repository, ["config", "user.name", "compatibility.fyi tests"]);
  git(repository, ["checkout", "--quiet", "-b", "master"]);

  mkdirSync(path.join(repository, ".gitlab"), { recursive: true });
  mkdirSync(path.join(repository, "clusters"), { recursive: true });
  writeFileSync(
    path.join(repository, ".gitlab", "compatibility-fyi.yaml"),
    defaultBranchConfiguration,
  );
  writeFileSync(path.join(repository, "operator.yaml"), operator127);
  writeFileSync(
    path.join(repository, "clusters", "database.yaml"),
    cluster("17.6"),
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  git(repository, ["push", "--quiet", "-u", "origin", "master"]);

  const branch = "renovate/postgresql-18.x";
  git(repository, ["checkout", "--quiet", "-b", branch]);
  writeFileSync(
    path.join(repository, "clusters", "database.yaml"),
    cluster("18.4"),
  );
  if (branchChangesPolicy) {
    writeFileSync(
      path.join(repository, ".gitlab", "compatibility-fyi.yaml"),
      configurationYaml.replace(
        "gates:\n",
        "defaults:\n  unknown: allow\n\ngates:\n",
      ),
    );
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "update dependency"]);
  return {
    repository,
    branch,
    sha: git(repository, ["rev-parse", "HEAD"]).trim(),
  };
}

async function withCompatibilityApi(
  compatible: "compatible" | "unknown",
  callback: (apiUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        project: url.searchParams.get("project"),
        version: url.searchParams.get("version"),
        dependency: url.searchParams.get("dependency"),
        dependencyVersion: url.searchParams.get("dependencyVersion"),
        compatible,
        matchedRange: compatible === "compatible" ? ">=17 <19" : null,
        relationship: null,
        confidence: "high",
        lastVerified: "2026-07-22",
        notes: [],
        sources: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}/api/v1/check`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function captureLogs(): {
  logger: GateLogger;
  infos: string[];
  warnings: string[];
  errors: string[];
} {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warnings,
    errors,
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url,
  );
}

function git(repository: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
