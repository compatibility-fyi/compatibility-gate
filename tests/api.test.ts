import { afterEach, describe, expect, it, vi } from "vitest";

import { CompatibilityApiClient } from "../src/api.js";

const request = {
  project: "cloudnativepg",
  version: "1.30",
  dependency: "postgresql",
  dependencyVersion: "18.4",
};

describe("CompatibilityApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates and returns the verification date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ...request,
        compatible: "compatible",
        matchedRange: ">=14.0.0 <19.0.0",
        relationship: "operand",
        confidence: "high",
        lastVerified: "2026-07-08",
        notes: [],
        sources: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new CompatibilityApiClient(
      "https://compatibility.fyi/api/v1/check",
      1000,
      0,
    ).check(request);

    expect(result.lastVerified).toBe("2026-07-08");
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "dependencyVersion=18.4",
    );
  });

  it("rejects malformed API responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...request })),
    );

    await expect(
      new CompatibilityApiClient(
        "https://compatibility.fyi/api/v1/check",
        1000,
        0,
      ).check(request),
    ).rejects.toThrow("compatible must be");
  });

  it("retries transient server failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          ...request,
          compatible: "compatible",
          matchedRange: ">=14.0.0 <19.0.0",
          relationship: "operand",
          confidence: "high",
          lastVerified: "2026-07-08",
          notes: [],
          sources: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CompatibilityApiClient(
        "https://compatibility.fyi/api/v1/check",
        1000,
        1,
      ).check(request),
    ).resolves.toMatchObject({ compatible: "compatible" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
