import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitRepositoryReader } from "../src/git.js";

const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("GitRepositoryReader", () => {
  it("uses an available event commit after its remote branch was deleted", async () => {
    const repository = mkdtempSync(
      path.join(tmpdir(), "compatibility-gate-git-"),
    );
    temporaryRepositories.push(repository);
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.email", "test@compatibility.fyi"]);
    git(repository, ["config", "user.name", "compatibility.fyi tests"]);
    writeFileSync(path.join(repository, "config.yaml"), "version: 1\n");
    git(repository, ["add", "config.yaml"]);
    git(repository, ["commit", "--quiet", "-m", "test fixture"]);
    const sha = git(repository, ["rev-parse", "HEAD"]).trim();

    const reader = new GitRepositoryReader(repository);

    expect(() =>
      reader.ensureCommit("renovate/deleted-after-automerge", sha),
    ).not.toThrow();
    await expect(reader.listFiles(sha)).resolves.toEqual(["config.yaml"]);
    await expect(reader.readFile(sha, "config.yaml")).resolves.toBe(
      "version: 1\n",
    );
  });
});

function git(repository: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
