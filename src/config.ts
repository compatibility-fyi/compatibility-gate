import { parseDocument } from "yaml";

import type {
  ConfidenceLevel,
  GateConfiguration,
  GateDefinition,
  GatePolicy,
  GatePolicyConfig,
  ValueSelector,
} from "./types.js";

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const confidenceLevels = new Set<ConfidenceLevel>(["low", "medium", "high"]);
const gatePolicies = new Set<GatePolicy>(["allow", "warn", "block"]);

const defaultPolicy: GatePolicyConfig = {
  unknown: "block",
  apiError: "block",
  minimumConfidence: "high",
};

export function parseConfiguration(raw: string): GateConfiguration {
  const document = parseDocument(raw, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const root = asRecord(document.toJS(), "configuration");
  assertKnownKeys(
    root,
    ["version", "api", "defaults", "gates"],
    "configuration",
  );

  if (root.version !== 1) {
    throw new Error("configuration.version must be 1");
  }

  const defaults = parsePolicy(
    root.defaults,
    "configuration.defaults",
    defaultPolicy,
  );
  const api = parseApi(root.api);
  const gatesValue = root.gates;
  if (!Array.isArray(gatesValue) || gatesValue.length === 0) {
    throw new Error("configuration.gates must contain at least one gate");
  }

  const gates = gatesValue.map((gate, index) =>
    parseGate(gate, index, defaults),
  );
  const duplicateId = gates.find((gate, index) =>
    gates.slice(0, index).some((candidate) => candidate.id === gate.id),
  );
  if (duplicateId) {
    throw new Error(
      `configuration.gates contains duplicate id ${duplicateId.id}`,
    );
  }

  return { version: 1, api, gates };
}

function parseApi(value: unknown): GateConfiguration["api"] {
  const api = value === undefined ? {} : asRecord(value, "configuration.api");
  assertKnownKeys(
    api,
    ["url", "timeoutSeconds", "retries"],
    "configuration.api",
  );

  const url =
    optionalString(api.url, "configuration.api.url") ??
    "https://compatibility.fyi/api/v1/check";
  validateApiUrl(url);

  const timeoutSeconds = optionalInteger(
    api.timeoutSeconds,
    "configuration.api.timeoutSeconds",
    1,
    60,
  );
  const retries = optionalInteger(
    api.retries,
    "configuration.api.retries",
    0,
    5,
  );

  return {
    url,
    timeoutMs: (timeoutSeconds ?? 10) * 1000,
    retries: retries ?? 2,
  };
}

export function validateApiUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("configuration.api.url must be a valid URL");
  }

  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(
      "configuration.api.url must use HTTPS unless it targets localhost",
    );
  }
}

function parseGate(
  value: unknown,
  index: number,
  defaults: GatePolicyConfig,
): GateDefinition {
  const path = `configuration.gates[${index}]`;
  const gate = asRecord(value, path);
  assertKnownKeys(gate, ["id", "project", "dependency", "policy"], path);

  const id = requiredIdentifier(gate.id, `${path}.id`);
  const project = asRecord(gate.project, `${path}.project`);
  assertKnownKeys(project, ["id", "version"], `${path}.project`);
  const dependency = asRecord(gate.dependency, `${path}.dependency`);
  assertKnownKeys(dependency, ["id", "versions"], `${path}.dependency`);

  return {
    id,
    project: {
      id: requiredIdentifier(project.id, `${path}.project.id`),
      version: parseSelector(project.version, `${path}.project.version`),
    },
    dependency: {
      id: requiredIdentifier(dependency.id, `${path}.dependency.id`),
      versions: parseSelector(
        dependency.versions,
        `${path}.dependency.versions`,
      ),
    },
    policy: parsePolicy(gate.policy, `${path}.policy`, defaults),
  };
}

function parseSelector(value: unknown, path: string): ValueSelector {
  const selector = asRecord(value, path);
  assertKnownKeys(selector, ["files", "document", "value", "extract"], path);

  const files = requiredStringArray(selector.files, `${path}.files`);
  const valuePath = requiredString(selector.value, `${path}.value`);
  if (valuePath.split(".").some((part) => part.length === 0)) {
    throw new Error(`${path}.value must be a dot-separated object path`);
  }

  const extract = optionalString(selector.extract, `${path}.extract`);
  if (extract) {
    try {
      new RegExp(extract);
    } catch (error) {
      throw new Error(
        `${path}.extract must be a valid regular expression: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  const document = parseDocumentSelector(selector.document, `${path}.document`);
  return {
    files,
    value: valuePath,
    ...(document ? { document } : {}),
    ...(extract ? { extract } : {}),
  };
}

function parseDocumentSelector(
  value: unknown,
  path: string,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const document = asRecord(value, path);
  if (Object.keys(document).length === 0) {
    throw new Error(`${path} must contain at least one field`);
  }

  const parsed: Record<string, string | number | boolean> = {};
  for (const [key, expected] of Object.entries(document)) {
    if (!key || key.split(".").some((part) => part.length === 0)) {
      throw new Error(`${path} keys must be dot-separated object paths`);
    }
    if (!["string", "number", "boolean"].includes(typeof expected)) {
      throw new Error(`${path}.${key} must be a string, number, or boolean`);
    }
    parsed[key] = expected as string | number | boolean;
  }
  return parsed;
}

function parsePolicy(
  value: unknown,
  path: string,
  inherited: GatePolicyConfig,
): GatePolicyConfig {
  if (value === undefined) {
    return { ...inherited };
  }

  const policy = asRecord(value, path);
  assertKnownKeys(
    policy,
    ["unknown", "apiError", "minimumConfidence", "maximumEvidenceAgeDays"],
    path,
  );

  const maximumEvidenceAgeDays = optionalInteger(
    policy.maximumEvidenceAgeDays,
    `${path}.maximumEvidenceAgeDays`,
    1,
    3650,
  );

  return {
    unknown:
      optionalPolicy(policy.unknown, `${path}.unknown`) ?? inherited.unknown,
    apiError:
      optionalPolicy(policy.apiError, `${path}.apiError`) ?? inherited.apiError,
    minimumConfidence:
      optionalConfidence(
        policy.minimumConfidence,
        `${path}.minimumConfidence`,
      ) ?? inherited.minimumConfidence,
    ...(maximumEvidenceAgeDays !== undefined
      ? { maximumEvidenceAgeDays }
      : inherited.maximumEvidenceAgeDays !== undefined
        ? { maximumEvidenceAgeDays: inherited.maximumEvidenceAgeDays }
        : {}),
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${path} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function requiredIdentifier(value: unknown, path: string): string {
  const identifier = requiredString(value, path);
  if (!identifierPattern.test(identifier)) {
    throw new Error(`${path} must use a lowercase-dash identifier`);
  }
  return identifier;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requiredString(value, path);
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must contain at least one file glob`);
  }
  const result = value.map((item, index) =>
    requiredString(item, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${path} must not contain duplicate globs`);
  }
  return result;
}

function optionalInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${path} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

function optionalConfidence(
  value: unknown,
  path: string,
): ConfidenceLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !confidenceLevels.has(value as ConfidenceLevel)
  ) {
    throw new Error(`${path} must be low, medium, or high`);
  }
  return value as ConfidenceLevel;
}

function optionalPolicy(value: unknown, path: string): GatePolicy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !gatePolicies.has(value as GatePolicy)) {
    throw new Error(`${path} must be allow, warn, or block`);
  }
  return value as GatePolicy;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
