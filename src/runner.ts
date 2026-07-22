import { CompatibilityApiClient } from "./api.js";
import { parseConfiguration, validateApiUrl } from "./config.js";
import { evaluateBranch, type CompatibilityChecker } from "./evaluate.js";
import { GitRepositoryReader } from "./git.js";
import type { BranchEvaluation, GateConfiguration } from "./types.js";

export interface PreparedGate {
  baseRef: string;
  configuration: GateConfiguration;
  checker: CompatibilityChecker;
}

export async function prepareGate(
  reader: GitRepositoryReader,
  baseBranch: string,
  configPath: string,
  apiOverride?: string,
): Promise<PreparedGate> {
  const baseRef = reader.fetchBranch(baseBranch);
  const rawConfiguration = await reader.readFile(baseRef, configPath);
  const configuration = parseConfiguration(rawConfiguration);

  if (apiOverride) {
    validateApiUrl(apiOverride);
    configuration.api.url = apiOverride;
  }

  return {
    baseRef,
    configuration,
    checker: new CompatibilityApiClient(
      configuration.api.url,
      configuration.api.timeoutMs,
      configuration.api.retries,
    ),
  };
}

export async function evaluateConfiguredBranch(
  reader: GitRepositoryReader,
  prepared: PreparedGate,
  branch: string,
  sha: string,
): Promise<BranchEvaluation> {
  try {
    reader.ensureCommit(branch, sha);
    return await evaluateBranch(
      branch,
      sha,
      prepared.baseRef,
      reader,
      prepared.configuration,
      prepared.checker,
    );
  } catch (error) {
    return {
      branch,
      sha,
      state: "error",
      description: `Gate execution error: ${errorMessage(error)}`,
      gates: [],
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
