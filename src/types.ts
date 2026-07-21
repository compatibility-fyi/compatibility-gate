export type CompatibilityStatus = "compatible" | "incompatible" | "unknown";
export type ConfidenceLevel = "low" | "medium" | "high";
export type GatePolicy = "allow" | "block";
export type CommitState = "error" | "failure" | "pending" | "success";

export interface CompatibilitySource {
  title: string;
  url: string;
  accessedAt?: string;
}

export interface CompatibilityCheckResponse {
  project: string;
  version: string;
  dependency: string;
  dependencyVersion: string;
  compatible: CompatibilityStatus;
  matchedRange: string | null;
  relationship: string | null;
  confidence: ConfidenceLevel;
  lastVerified: string | null;
  notes: string[];
  sources: CompatibilitySource[];
}

export interface ValueSelector {
  files: string[];
  document?: Record<string, string | number | boolean>;
  value: string;
  extract?: string;
}

export interface GatePolicyConfig {
  unknown: GatePolicy;
  apiError: GatePolicy;
  minimumConfidence: ConfidenceLevel;
  maximumEvidenceAgeDays?: number;
}

export interface GateDefinition {
  id: string;
  project: {
    id: string;
    version: ValueSelector;
  };
  dependency: {
    id: string;
    versions: ValueSelector;
  };
  policy: GatePolicyConfig;
}

export interface GateConfiguration {
  version: 1;
  api: {
    url: string;
    timeoutMs: number;
    retries: number;
  };
  gates: GateDefinition[];
}

export interface RepositoryReader {
  listFiles(ref: string): Promise<string[]>;
  readFile(ref: string, path: string): Promise<string>;
}

export interface CheckDecision {
  state: Exclude<CommitState, "pending">;
  gateId: string;
  project: string;
  projectVersion: string;
  dependency: string;
  dependencyVersion: string;
  message: string;
  response?: CompatibilityCheckResponse;
}

export interface GateEvaluation {
  gateId: string;
  applicable: boolean;
  decisions: CheckDecision[];
  message: string;
}

export interface BranchEvaluation {
  branch: string;
  sha: string;
  state: Exclude<CommitState, "pending">;
  description: string;
  gates: GateEvaluation[];
}

export interface RepositoryBranch {
  name: string;
  sha: string;
}
