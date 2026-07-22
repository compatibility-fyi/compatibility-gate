import type { CompatibilityCheckRequest } from "./api.js";
import { resolveSelector } from "./selectors.js";
import type {
  BranchEvaluation,
  CheckDecision,
  CompatibilityCheckResponse,
  ConfidenceLevel,
  GateConfiguration,
  GateDefinition,
  GateEvaluation,
  RepositoryReader,
} from "./types.js";

export interface CompatibilityChecker {
  check(
    request: CompatibilityCheckRequest,
  ): Promise<CompatibilityCheckResponse>;
}

const confidenceRank: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export async function evaluateBranch(
  branch: string,
  sha: string,
  baseRef: string,
  reader: RepositoryReader,
  configuration: GateConfiguration,
  checker: CompatibilityChecker,
  now = new Date(),
): Promise<BranchEvaluation> {
  const gates: GateEvaluation[] = [];
  for (const gate of configuration.gates) {
    gates.push(await evaluateGate(gate, baseRef, sha, reader, checker, now));
  }

  const decisions = gates.flatMap((gate) => gate.decisions);
  const state = decisions.some((decision) => decision.state === "error")
    ? "error"
    : decisions.some((decision) => decision.state === "failure")
      ? "failure"
      : "success";

  const blocked = decisions.find((decision) => decision.state !== "success");
  const applicable = gates.filter((gate) => gate.applicable);
  const description = blocked
    ? blocked.message
    : applicable.length === 0
      ? "No configured compatibility gate applies"
      : decisions.length === 1
        ? decisions[0]!.message
        : `${decisions.length} compatibility checks passed`;

  return { branch, sha, state, description, gates };
}

async function evaluateGate(
  gate: GateDefinition,
  baseRef: string,
  headRef: string,
  reader: RepositoryReader,
  checker: CompatibilityChecker,
  now: Date,
): Promise<GateEvaluation> {
  let baseProjectVersions: string[];
  let headProjectVersions: string[];
  let baseDependencyVersions: string[];
  let headDependencyVersions: string[];
  try {
    [
      baseProjectVersions,
      headProjectVersions,
      baseDependencyVersions,
      headDependencyVersions,
    ] = await Promise.all([
      resolveSelector(reader, baseRef, gate.project.version),
      resolveSelector(reader, headRef, gate.project.version),
      resolveSelector(reader, baseRef, gate.dependency.versions),
      resolveSelector(reader, headRef, gate.dependency.versions),
    ]);
  } catch (error) {
    return gateConfigurationError(gate, errorMessage(error));
  }

  const applicable =
    !sameValues(baseProjectVersions, headProjectVersions) ||
    !sameValues(baseDependencyVersions, headDependencyVersions);
  if (!applicable) {
    return {
      gateId: gate.id,
      applicable: false,
      decisions: [],
      message: "Configured versions did not change",
    };
  }

  if (headDependencyVersions.length === 0) {
    return {
      gateId: gate.id,
      applicable: true,
      decisions: [],
      message: "No dependency versions remain in the proposed repository state",
    };
  }

  if (headProjectVersions.length !== 1) {
    return gateConfigurationError(
      gate,
      `project selector returned ${headProjectVersions.length} values; exactly one is required`,
      true,
    );
  }

  const projectVersion = headProjectVersions[0]!;
  const decisions: CheckDecision[] = [];
  for (const dependencyVersion of headDependencyVersions) {
    decisions.push(
      await evaluateCheck(
        gate,
        projectVersion,
        dependencyVersion,
        checker,
        now,
      ),
    );
  }

  const blocked = decisions.find((decision) => decision.state !== "success");
  return {
    gateId: gate.id,
    applicable: true,
    decisions,
    message:
      blocked?.message ?? `${decisions.length} compatibility check(s) passed`,
  };
}

async function evaluateCheck(
  gate: GateDefinition,
  projectVersion: string,
  dependencyVersion: string,
  checker: CompatibilityChecker,
  now: Date,
): Promise<CheckDecision> {
  const base = {
    gateId: gate.id,
    project: gate.project.id,
    projectVersion,
    dependency: gate.dependency.id,
    dependencyVersion,
  };

  let response: CompatibilityCheckResponse;
  try {
    response = await checker.check({
      project: gate.project.id,
      version: projectVersion,
      dependency: gate.dependency.id,
      dependencyVersion,
    });
  } catch (error) {
    const allowed = gate.policy.apiError === "allow";
    return {
      ...base,
      state: allowed ? "success" : "error",
      message: `${gate.id}: API error ${allowed ? "allowed" : "blocked"}: ${errorMessage(error)}`,
    };
  }

  if (response.compatible === "incompatible") {
    return {
      ...base,
      state: "failure",
      message: `${gate.project.id} ${projectVersion} does not support ${gate.dependency.id} ${dependencyVersion}`,
      response,
    };
  }

  if (response.compatible === "unknown") {
    const allowed = gate.policy.unknown === "allow";
    return {
      ...base,
      state: allowed ? "success" : "error",
      message: `${gate.id}: unknown compatibility ${allowed ? "allowed" : "blocked"}`,
      response,
    };
  }

  if (
    confidenceRank[response.confidence] <
    confidenceRank[gate.policy.minimumConfidence]
  ) {
    return {
      ...base,
      state: "failure",
      message: `${gate.id}: ${response.confidence} confidence is below required ${gate.policy.minimumConfidence}`,
      response,
    };
  }

  if (gate.policy.maximumEvidenceAgeDays !== undefined) {
    const age = evidenceAgeDays(response.lastVerified, now);
    if (age === null || age > gate.policy.maximumEvidenceAgeDays) {
      return {
        ...base,
        state: "failure",
        message:
          age === null
            ? `${gate.id}: compatibility evidence has no valid verification date`
            : `${gate.id}: compatibility evidence is ${age} days old`,
        response,
      };
    }
  }

  return {
    ...base,
    state: "success",
    message: `${gate.project.id} ${projectVersion} supports ${gate.dependency.id} ${dependencyVersion}`,
    response,
  };
}

function gateConfigurationError(
  gate: GateDefinition,
  message: string,
  applicable = true,
): GateEvaluation {
  return {
    gateId: gate.id,
    applicable,
    decisions: [
      {
        state: "error",
        gateId: gate.id,
        project: gate.project.id,
        projectVersion: "?",
        dependency: gate.dependency.id,
        dependencyVersion: "?",
        message: `${gate.id}: ${message}`,
      },
    ],
    message,
  };
}

function sameValues(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

function evidenceAgeDays(
  lastVerified: string | null,
  now: Date,
): number | null {
  if (!lastVerified) {
    return null;
  }
  const verifiedAt = new Date(`${lastVerified}T00:00:00Z`);
  if (
    Number.isNaN(verifiedAt.getTime()) ||
    verifiedAt.toISOString().slice(0, 10) !== lastVerified ||
    verifiedAt.getTime() > now.getTime()
  ) {
    return null;
  }
  return Math.max(
    0,
    Math.floor((now.getTime() - verifiedAt.getTime()) / 86_400_000),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
