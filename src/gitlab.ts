import { minimatch } from "minimatch";

import { GitRepositoryReader } from "./git.js";
import { evaluateConfiguredBranch, prepareGate } from "./runner.js";
import type { BranchEvaluation } from "./types.js";

const defaultBranchPattern = "renovate/**";
const defaultConfigPath = ".gitlab/compatibility-fyi.yaml";
const maxGitLabResponseBytes = 2 * 1024 * 1024;

export interface GateLogger {
  info(message: string): void;
  error(message: string): void;
}

export async function runGitLabGate(
  environment: NodeJS.ProcessEnv = process.env,
  logger: GateLogger = consoleLogger,
  workingDirectory = process.cwd(),
): Promise<number> {
  try {
    const branch =
      environment.CI_COMMIT_BRANCH ??
      environment.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ??
      environment.CI_COMMIT_REF_NAME;
    if (!branch) {
      throw new Error("CI_COMMIT_BRANCH is required");
    }

    const branchPattern =
      environment.COMPATIBILITY_FYI_BRANCH_PATTERN ?? defaultBranchPattern;
    validateBranchPattern(branchPattern);
    if (!minimatch(branch, branchPattern, { dot: true, nonegate: true })) {
      logger.info(
        singleLine(`No compatibility gate applies to branch ${branch}`),
      );
      return 0;
    }

    const sha = requiredEnvironment(environment, "CI_COMMIT_SHA");
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error("CI_COMMIT_SHA must be a full lowercase commit SHA");
    }
    const baseBranch =
      environment.COMPATIBILITY_FYI_BASE_BRANCH ??
      requiredEnvironment(environment, "CI_DEFAULT_BRANCH");
    const configPath =
      environment.COMPATIBILITY_FYI_CONFIG_FILE ?? defaultConfigPath;
    const apiOverride = environment.COMPATIBILITY_FYI_API_URL || undefined;

    const reader = new GitRepositoryReader(workingDirectory);
    const prepared = await prepareGate(
      reader,
      baseBranch,
      configPath,
      apiOverride,
    );
    const evaluation = await evaluateConfiguredBranch(
      reader,
      prepared,
      branch,
      sha,
    );
    writeEvaluation(evaluation, logger);
    return evaluation.state === "success" ? 0 : 1;
  } catch (error) {
    logger.error(
      singleLine(`Compatibility gate error: ${errorMessage(error)}`),
    );
    return 1;
  }
}

export async function runGitLabRecheck(
  environment: NodeJS.ProcessEnv = process.env,
  logger: GateLogger = consoleLogger,
  fetchImplementation: typeof fetch = fetch,
): Promise<number> {
  const triggerToken = environment.COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN;
  const jobToken = environment.CI_JOB_TOKEN;
  try {
    const apiUrl = validateGitLabApiUrl(
      requiredEnvironment(environment, "CI_API_V4_URL"),
    );
    const projectId = requiredEnvironment(environment, "CI_PROJECT_ID");
    if (!/^[1-9]\d*$/.test(projectId)) {
      throw new Error("CI_PROJECT_ID must be a positive integer");
    }
    const branchReadToken = requiredEnvironment(environment, "CI_JOB_TOKEN");
    const token = requiredEnvironment(
      environment,
      "COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN",
    );
    const branchPattern =
      environment.COMPATIBILITY_FYI_BRANCH_PATTERN ?? defaultBranchPattern;
    validateBranchPattern(branchPattern);

    const branches = await listGitLabBranches(
      apiUrl,
      projectId,
      branchReadToken,
      branchPattern,
      fetchImplementation,
    );
    if (branches.length === 0) {
      logger.info(
        singleLine(`No branches matched ${branchPattern}; nothing to recheck`),
      );
      return 0;
    }

    for (const branch of branches) {
      await triggerGitLabPipeline(
        apiUrl,
        projectId,
        token,
        branch,
        fetchImplementation,
      );
      logger.info(singleLine(`Triggered compatibility recheck for ${branch}`));
    }
    logger.info(
      `Triggered ${branches.length} compatibility recheck pipeline(s)`,
    );
    return 0;
  } catch (error) {
    logger.error(
      singleLine(
        `Compatibility recheck error: ${redactSecrets(errorMessage(error), [triggerToken, jobToken])}`,
      ),
    );
    return 1;
  }
}

async function listGitLabBranches(
  apiUrl: string,
  projectId: string,
  jobToken: string,
  pattern: string,
  fetchImplementation: typeof fetch,
): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(
      `${apiUrl}/projects/${encodeURIComponent(projectId)}/repository/branches`,
    );
    url.search = new URLSearchParams({
      per_page: "100",
      page: String(page),
    }).toString();
    const response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        "JOB-TOKEN": jobToken,
        "User-Agent": "compatibility-fyi-gate",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readLimitedText(response);
    if (!response.ok) {
      throw new Error(`GitLab branch API returned HTTP ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("GitLab branch API returned invalid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("GitLab branch API response must be an array");
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("GitLab branch API entry must be an object");
      }
      const name = (entry as Record<string, unknown>).name;
      if (typeof name !== "string" || !name) {
        throw new Error("GitLab branch API entry is missing name");
      }
      if (minimatch(name, pattern, { dot: true, nonegate: true })) {
        branches.push(name);
      }
    }

    if (parsed.length < 100) {
      return branches;
    }
  }
  throw new Error("Refusing to paginate more than 10,000 GitLab branches");
}

async function triggerGitLabPipeline(
  apiUrl: string,
  projectId: string,
  triggerToken: string,
  branch: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const response = await fetchImplementation(
    `${apiUrl}/projects/${encodeURIComponent(projectId)}/trigger/pipeline`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "compatibility-fyi-gate",
      },
      body: new URLSearchParams({ token: triggerToken, ref: branch }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  await readLimitedText(response);
  if (!response.ok) {
    throw new Error(
      `GitLab pipeline trigger API returned HTTP ${response.status}`,
    );
  }
}

function writeEvaluation(
  evaluation: BranchEvaluation,
  logger: GateLogger,
): void {
  const summary = singleLine(`${evaluation.branch}: ${evaluation.description}`);
  if (evaluation.state === "success") {
    logger.info(summary);
  } else {
    logger.error(summary);
  }
  for (const gate of evaluation.gates) {
    if (!gate.applicable) {
      logger.info(singleLine(`${gate.gateId}: ${gate.message}`));
      continue;
    }
    for (const decision of gate.decisions) {
      if (decision.state === "success") {
        logger.info(singleLine(decision.message));
      } else {
        logger.error(singleLine(decision.message));
      }
      for (const source of decision.response?.sources ?? []) {
        logger.info(singleLine(`Source: ${source.title} (${source.url})`));
      }
    }
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxGitLabResponseBytes) {
    throw new Error(
      `GitLab API response exceeded ${maxGitLabResponseBytes} bytes`,
    );
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
    if (total > maxGitLabResponseBytes) {
      await reader.cancel();
      throw new Error(
        `GitLab API response exceeded ${maxGitLabResponseBytes} bytes`,
      );
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateBranchPattern(pattern: string): void {
  if (!pattern.trim() || pattern.length > 512 || /[\r\n\0]/.test(pattern)) {
    throw new Error(
      "COMPATIBILITY_FYI_BRANCH_PATTERN must contain 1 to 512 characters without line breaks",
    );
  }
}

function validateGitLabApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CI_API_V4_URL must be a valid URL");
  }
  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("CI_API_V4_URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function redactSecrets(
  message: string,
  secrets: Array<string | undefined>,
): string {
  return secrets.reduce<string>(
    (redacted, secret) =>
      secret ? redacted.replaceAll(secret, "[REDACTED]") : redacted,
    message,
  );
}

function singleLine(message: string): string {
  return message.replace(/[\r\n\0]+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const consoleLogger: GateLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};
