import type {
  CompatibilityCheckResponse,
  CompatibilitySource,
  CompatibilityStatus,
  ConfidenceLevel,
} from "./types";

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

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "compatibility-fyi-gate (+https://github.com/compatibility-fyi/compatibility-gate)",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await readLimitedText(response);

        if (!response.ok) {
          const error = new Error(
            `compatibility.fyi returned HTTP ${response.status}: ${body}`,
          );
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < this.retries
          ) {
            lastError = error;
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
        lastError = error;
        if (attempt < this.retries && isRetryableNetworkError(error)) {
          await delay(250 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  if (lastVerified && !/^\d{4}-\d{2}-\d{2}$/.test(lastVerified)) {
    throw new Error("API response lastVerified must be an ISO date or null");
  }

  return {
    ...request,
    compatible: response.compatible as CompatibilityStatus,
    matchedRange: optionalNullableString(
      response.matchedRange,
      "API response matchedRange",
    ),
    relationship: optionalNullableString(
      response.relationship,
      "API response relationship",
    ),
    confidence: response.confidence as ConfidenceLevel,
    lastVerified,
    notes: stringArray(response.notes, "API response notes"),
    sources: sourceArray(response.sources),
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

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxResponseBytes) {
    throw new Error(`API response exceeded ${maxResponseBytes} bytes`);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new Error(`API response exceeded ${maxResponseBytes} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
