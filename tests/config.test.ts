import { describe, expect, it } from "vitest";

import { parseConfiguration } from "../src/config.js";
import { configurationYaml } from "./helpers.js";

describe("parseConfiguration", () => {
  it("parses the documented configuration with fail-closed defaults", () => {
    const configuration = parseConfiguration(configurationYaml);

    expect(configuration).toMatchObject({
      version: 1,
      api: {
        url: "https://compatibility.fyi/api/v1/check",
        timeoutMs: 10_000,
        retries: 2,
      },
      gates: [
        {
          id: "cnpg-postgresql",
          policy: {
            unknown: "block",
            apiError: "block",
            minimumConfidence: "high",
          },
        },
      ],
    });
  });

  it("allows explicit policy and API overrides", () => {
    const configuration = parseConfiguration(`${configurationYaml}
api:
  url: https://example.com/check
  timeoutSeconds: 5
  retries: 0
defaults:
  unknown: allow
  apiError: allow
  minimumConfidence: medium
  maximumEvidenceAgeDays: 180
`);

    expect(configuration.api).toEqual({
      url: "https://example.com/check",
      timeoutMs: 5000,
      retries: 0,
    });
    expect(configuration.gates[0]!.policy).toEqual({
      unknown: "allow",
      apiError: "allow",
      minimumConfidence: "medium",
      maximumEvidenceAgeDays: 180,
    });
  });

  it("rejects unknown fields so policy typos cannot silently bypass a gate", () => {
    expect(() =>
      parseConfiguration(
        configurationYaml.replace(
          "id: cnpg-postgresql",
          "id: cnpg-postgresql\n    enabled: true",
        ),
      ),
    ).toThrow("contains unknown field: enabled");
  });

  it("rejects insecure remote API endpoints", () => {
    expect(() =>
      parseConfiguration(`${configurationYaml}
api:
  url: http://example.com/check
`),
    ).toThrow("must use HTTPS");
  });

  it("rejects extract patterns without valid regular-expression syntax", () => {
    expect(() =>
      parseConfiguration(
        configurationYaml.replace("':(?<version>[^@]+)$'", "'['"),
      ),
    ).toThrow("must be a valid regular expression");
  });
});
