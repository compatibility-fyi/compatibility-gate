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
  it("uses an available event commit without fetching its remote branch", async () => {
    const { repository, sha } = createRepository();

    const reader = new GitRepositoryReader(repository);

    reader.ensureCommit("renovate/deleted-after-automerge", sha);
    await expect(reader.listFiles(sha)).resolves.toEqual(["config.yaml"]);
    await expect(reader.readFile(sha, "config.yaml")).resolves.toBe(
      "version: 1\n",
    );
  });

  it.each(["rénover/dependency", "release+1.0", "release@1.0"])(
    "reads valid remote branch references containing %s",
    async (branch) => {
      const { repository, sha } = createRepository();
      const ref = `refs/remotes/origin/${branch}`;
      git(repository, ["update-ref", ref, sha]);
      const reader = new GitRepositoryReader(repository);
      await expect(reader.listFiles(ref)).resolves.toEqual(["config.yaml"]);
      await expect(reader.readFile(ref, "config.yaml")).resolves.toBe(
        "version: 1\n",
      );
    },
  );

  it.each(["--all", "HEAD", "refs/remotes/origin/master~1"])(
    "rejects references outside the allowed namespace or ref syntax: %s",
    (ref) => {
      const reader = new GitRepositoryReader();
      expect(() => reader.listFiles(ref)).toThrow("Invalid git reference");
      expect(() => reader.readFile(ref, "config.yaml")).toThrow(
        "Invalid git reference",
      );
    },
  );
});

function createRepository(): { repository: string; sha: string } {
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
  return { repository, sha: git(repository, ["rev-parse", "HEAD"]).trim() };
}

function git(repository: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
