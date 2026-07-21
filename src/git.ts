import { execFileSync } from "node:child_process";
import path from "node:path";

import type { RepositoryReader } from "./types";

const maxFileBytes = 2 * 1024 * 1024;
const maxTreeBytes = 20 * 1024 * 1024;

export class GitRepositoryReader implements RepositoryReader {
  constructor(private readonly workingDirectory = process.cwd()) {}

  fetchBranch(branch: string): string {
    validateBranch(branch);
    const remoteRef = this.remoteRef(branch);
    this.git([
      "fetch",
      "--force",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:${remoteRef}`,
    ]);
    return remoteRef;
  }

  remoteRef(branch: string): string {
    validateBranch(branch);
    return `refs/remotes/origin/${branch}`;
  }

  listFiles(ref: string): Promise<string[]> {
    validateRef(ref);
    const output = this.git(
      ["ls-tree", "-r", "-z", "--name-only", ref],
      maxTreeBytes,
    );
    return Promise.resolve(output.split("\0").filter(Boolean));
  }

  readFile(ref: string, file: string): Promise<string> {
    validateRef(ref);
    validateRepositoryPath(file);
    try {
      return Promise.resolve(
        this.git(["show", `${ref}:${file}`], maxFileBytes),
      );
    } catch (error) {
      throw new Error(
        `Unable to read ${file} at ${ref}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private git(arguments_: string[], maxBuffer = 8 * 1024 * 1024): string {
    return execFileSync("git", arguments_, {
      cwd: this.workingDirectory,
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function validateBranch(branch: string): void {
  if (
    !branch ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch.includes("\0")
  ) {
    throw new Error(`Invalid branch name ${JSON.stringify(branch)}`);
  }
  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Invalid branch name ${JSON.stringify(branch)}`);
  }
}

function validateRef(ref: string): void {
  if (
    !ref ||
    ref.length > 512 ||
    ref.startsWith("-") ||
    ref.includes("\0") ||
    !/^(?:[a-f0-9]{40}|refs\/remotes\/origin\/[A-Za-z0-9._/-]+)$/.test(ref)
  ) {
    throw new Error(`Invalid git reference ${JSON.stringify(ref)}`);
  }
}

function validateRepositoryPath(file: string): void {
  if (
    !file ||
    file.length > 1024 ||
    file.includes("\0") ||
    file.includes(":") ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.startsWith("../")
  ) {
    throw new Error(`Invalid repository path ${JSON.stringify(file)}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string }).stderr?.trim();
    return stderr || error.message;
  }
  return String(error);
}
