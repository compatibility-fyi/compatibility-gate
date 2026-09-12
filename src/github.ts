import { minimatch } from "minimatch";

import { readLimitedText } from "./http.js";

import type { CommitState, RepositoryBranch } from "./types.js";

const maxResponseBytes = 2 * 1024 * 1024;

export class GitHubClient {
  private readonly apiUrl: string;

  constructor(
    private readonly token: string,
    private readonly repository: string,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    if (!/^[^/]+\/[^/]+$/.test(repository)) {
      throw new Error("GITHUB_REPOSITORY must use owner/repository format");
    }
  }

  async getDefaultBranch(): Promise<string> {
    const response = await this.request("GET", `/repos/${this.repository}`);
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("GitHub repository response must be an object");
    }
    const defaultBranch = (response as Record<string, unknown>).default_branch;
    if (typeof defaultBranch !== "string" || !defaultBranch) {
      throw new Error(
        "GitHub repository response did not include default_branch",
      );
    }
    return defaultBranch;
  }

  async listBranches(pattern: string): Promise<RepositoryBranch[]> {
    const branches: RepositoryBranch[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request(
        "GET",
        `/repos/${this.repository}/branches?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response)) {
        throw new Error("GitHub branches response must be an array");
      }

      for (const branch of response) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
          throw new Error("GitHub branch entry must be an object");
        }
        const record = branch as Record<string, unknown>;
        const commit = record.commit;
        if (
          typeof record.name !== "string" ||
          !commit ||
          typeof commit !== "object" ||
          Array.isArray(commit) ||
          typeof (commit as Record<string, unknown>).sha !== "string"
        ) {
          throw new Error("GitHub branch entry is missing name or commit SHA");
        }
        if (minimatch(record.name, pattern, { dot: true, nonegate: true })) {
          branches.push({
            name: record.name,
            sha: (commit as Record<string, unknown>).sha as string,
          });
        }
      }

      if (response.length < 100) {
        break;
      }
      if (page >= 100) {
        throw new Error(
          "Refusing to paginate more than 10,000 repository branches",
        );
      }
    }
    return branches;
  }

  async createStatus(
    sha: string,
    state: CommitState,
    context: string,
    description: string,
    targetUrl: string | undefined,
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.repository}/statuses/${encodeURIComponent(sha)}`,
      {
        state,
        context,
        description: truncate(description.replace(/\s+/g, " ").trim(), 140),
        ...(targetUrl ? { target_url: targetUrl } : {}),
      },
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "compatibility-fyi-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await readLimitedText(
      response,
      maxResponseBytes,
      "GitHub API",
    );
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("GitHub API returned invalid JSON");
    }
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
