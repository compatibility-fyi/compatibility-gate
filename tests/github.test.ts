import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubClient } from "../src/github.js";

describe("GitHubClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers only matching Renovate branches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { name: "master", commit: { sha: "a".repeat(40) } },
        { name: "renovate/postgresql-18.x", commit: { sha: "b".repeat(40) } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubClient("token", "owner/repository").listBranches("renovate/**"),
    ).resolves.toEqual([
      { name: "renovate/postgresql-18.x", sha: "b".repeat(40) },
    ]);
  });

  it("publishes a bounded commit status without exposing the token in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubClient("secret-token", "owner/repository").createStatus(
      "c".repeat(40),
      "failure",
      "compatibility.fyi/gate",
      "x".repeat(200),
      "https://github.com/owner/repository/actions/runs/1",
    );

    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const [url, options] = calls[0]!;
    if (typeof options.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    const body = JSON.parse(options.body) as Record<string, string>;
    expect(String(url)).toContain(`/statuses/${"c".repeat(40)}`);
    expect(body).toMatchObject({
      state: "failure",
      context: "compatibility.fyi/gate",
      target_url: "https://github.com/owner/repository/actions/runs/1",
    });
    expect(body.description).toHaveLength(140);
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});
