import { setTimeout as delay } from "node:timers/promises";

import { readLimitedText } from "./http.js";
import type {
  CompatibilityBasis,
  CompatibilityCheckResponse,
  CompatibilitySource,
  CompatibilityStatus,
  ConfidenceLevel,
} from "./types.js";

const maxResponseBytes = 1024 * 1024;
const compatibilityStatuses = new Set<CompatibilityStatus>([
  "compatible",
  "incompatible",
  "unknown",
]);
const confidenceLevels = new Set<ConfidenceLevel>(["low", "medium", "high"]);

export interface CompatibilityCheckRequest {
  project: string;
  version: string;
  dependency: string;
  dependencyVersion: string;
}

export class CompatibilityApiClient {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    private readonly retries: number,
  ) {}

  async check(
    request: CompatibilityCheckRequest,
  ): Promise<CompatibilityCheckResponse> {
    const url = new URL(this.endpoint);
    url.search = new URLSearchParams({
      project: request.project,
      version: request.version,
      dependency: request.dependency,
      dependencyVersion: request.dependencyVersion,
    }).toString();

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "compatibility-fyi-gate (+https://github.com/compatibility-fyi/compatibility-gate)",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await readLimitedText(response, maxResponseBytes);

        if (!response.ok) {
          const error = new Error(
            `compatibility.fyi returned HTTP ${response.status}`,
          );
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < this.retries
          ) {
            await delay(250 * 2 ** attempt);
            continue;
          }
          throw error;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error("compatibility.fyi returned invalid JSON");
        }
        return validateResponse(parsed, request);
      } catch (error) {
        if (attempt < this.retries && isRetryableNetworkError(error)) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
  }
}

function validateResponse(
  value: unknown,
  request: CompatibilityCheckRequest,
): CompatibilityCheckResponse {
  const response = asRecord(value, "API response");
  for (const [key, expected] of Object.entries(request)) {
    if (response[key] !== expected) {
      throw new Error(`API response ${key} did not match the request`);
    }
  }

  if (
    typeof response.compatible !== "string" ||
    !compatibilityStatuses.has(response.compatible as CompatibilityStatus)
  ) {
    throw new Error(
      "API response compatible must be compatible, incompatible, or unknown",
    );
  }
  if (
    typeof response.confidence !== "string" ||
    !confidenceLevels.has(response.confidence as ConfidenceLevel)
  ) {
    throw new Error("API response confidence must be low, medium, or high");
  }

  const lastVerified = optionalNullableString(
    response.lastVerified,
    "API response lastVerified",
  );
  if (lastVerified !== null) {
    validateDate(lastVerified, "API response lastVerified");
  }
  const basis = optionalNullableString(response.basis, "API response basis");
  if (
    basis !== null &&
    !["supported", "tested", "recommended", "bundled"].includes(basis)
  ) {
    throw new Error(
      "API response basis must be supported, tested, recommended, bundled, or null",
    );
  }
  const matchedConstraint = optionalNullableString(
    response.matchedConstraint,
    "API response matchedConstraint",
  );
  if (matchedConstraint !== null && matchedConstraint !== "same-version") {
    throw new Error(
      "API response matchedConstraint must be same-version or null",
    );
  }
  const matchedRange = optionalNullableString(
    response.matchedRange,
    "API response matchedRange",
  );
  const sources = sourceArray(response.sources);
  if (response.compatible === "compatible") {
    if (basis === "recommended" || basis === "bundled") {
      throw new Error(
        "API response cannot establish compatibility from recommendations or bundles",
      );
    }
    if (!matchedRange?.trim() && !matchedConstraint) {
      throw new Error(
        "API response compatible result must include a matched constraint",
      );
    }
  }
  if (response.confidence !== "low" && sources.length === 0) {
    throw new Error(
      "API response must include sources for medium or high confidence",
    );
  }
  if (response.confidence === "high" && lastVerified === null) {
    throw new Error(
      "API response high confidence requires a verification date",
    );
  }

  return {
    ...request,
    compatible: response.compatible as CompatibilityStatus,
    matchedRange,
    matchedConstraint,
    basis: basis as CompatibilityBasis | null,
    relationship: optionalNullableString(
      response.relationship,
      "API response relationship",
    ),
    confidence: response.confidence as ConfidenceLevel,
    lastVerified,
    notes: stringArray(response.notes, "API response notes"),
    sources,
  };
}

function sourceArray(value: unknown): CompatibilitySource[] {
  if (!Array.isArray(value)) {
    throw new Error("API response sources must be an array");
  }
  return value.map((source, index) => {
    const record = asRecord(source, `API response sources[${index}]`);
    const title = requiredString(
      record.title,
      `API response sources[${index}].title`,
    );
    const url = requiredString(
      record.url,
      `API response sources[${index}].url`,
    );
    validateSourceUrl(url, `API response sources[${index}].url`);
    const accessedAt = optionalNullableString(
      record.accessedAt,
      `API response sources[${index}].accessedAt`,
    );
    if (accessedAt !== null) {
      validateDate(accessedAt, `API response sources[${index}].accessedAt`);
    }
    return { title, url, ...(accessedAt ? { accessedAt } : {}) };
  });
}

function validateSourceUrl(value: string, path: string): void {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch (error) {
    throw new Error(`${path} must be an HTTP(S) URL`, { cause: error });
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string or null`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value;
}

function isRetryableNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name))
  );
}

function validateDate(value: string, path: string): void {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${path} must be a valid ISO date`);
  }
}
