import * as core from "@actions/core";
import { minimatch } from "minimatch";

import { GitRepositoryReader } from "./git.js";
import { GitHubClient } from "./github.js";
import {
  evaluateConfiguredBranch,
  prepareGate,
  type PreparedGate,
} from "./runner.js";
import type { BranchEvaluation, RepositoryBranch } from "./types.js";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const repository = requiredEnvironment("GITHUB_REPOSITORY");
    const branchPattern = core.getInput("branch-pattern") || "renovate/**";
    const statusContext =
      core.getInput("status-context") || "compatibility.fyi/gate";
    validateStatusContext(statusContext);

    const github = new GitHubClient(token, repository);
    const baseBranch =
      core.getInput("base-branch") || (await github.getDefaultBranch());
    const branches = await selectBranches(github, branchPattern);
    const targetUrl = workflowRunUrl(repository);

    if (branches.length === 0) {
      core.info(`No branches matched ${branchPattern}`);
      await writeSummary([], `No branches matched \`${branchPattern}\`.`);
      setOutputs(0, 0);
      return;
    }

    for (const branch of branches) {
      await github.createStatus(
        branch.sha,
        "pending",
        statusContext,
        "Evaluating source-backed compatibility",
        targetUrl,
      );
    }

    const reader = new GitRepositoryReader();
    let prepared: PreparedGate;
    try {
      const configPath =
        core.getInput("config-file") || ".github/compatibility-fyi.yaml";
      const apiOverride = core.getInput("api-url");
      prepared = await prepareGate(
        reader,
        baseBranch,
        configPath,
        apiOverride || undefined,
      );
    } catch (error) {
      const message = `Gate configuration error: ${errorMessage(error)}`;
      for (const branch of branches) {
        await github.createStatus(
          branch.sha,
          "error",
          statusContext,
          message,
          targetUrl,
        );
      }
      core.warning(message);
      await writeSummary([], message);
      setOutputs(branches.length, branches.length);
      return;
    }

    const evaluations: BranchEvaluation[] = [];

    for (const branch of branches) {
      const evaluation = await evaluateConfiguredBranch(
        reader,
        prepared,
        branch.name,
        branch.sha,
      );

      await github.createStatus(
        branch.sha,
        evaluation.state,
        statusContext,
        evaluation.description,
        targetUrl,
      );
      evaluations.push(evaluation);

      if (evaluation.state === "success") {
        core.info(`${branch.name}: ${evaluation.description}`);
      } else {
        core.warning(`${branch.name}: ${evaluation.description}`);
      }
    }

    const blocked = evaluations.filter(
      (evaluation) => evaluation.state !== "success",
    ).length;
    await writeSummary(evaluations);
    setOutputs(evaluations.length, blocked);
  } catch (error) {
    core.setFailed(errorMessage(error));
  }
}

async function selectBranches(
  github: GitHubClient,
  branchPattern: string,
): Promise<RepositoryBranch[]> {
  const requestedMode = (core.getInput("mode") || "auto").toLowerCase();
  if (!["all", "auto", "current"].includes(requestedMode)) {
    throw new Error("mode must be auto, current, or all");
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const refName = process.env.GITHUB_REF_NAME ?? "";
  const mode =
    requestedMode === "auto"
      ? eventName === "push" &&
        minimatch(refName, branchPattern, { dot: true, nonegate: true })
        ? "current"
        : "all"
      : requestedMode;

  if (mode === "all") {
    return github.listBranches(branchPattern);
  }

  if (
    !refName ||
    !minimatch(refName, branchPattern, { dot: true, nonegate: true })
  ) {
    return [];
  }
  const sha = requiredEnvironment("GITHUB_SHA");
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("GITHUB_SHA must be a full commit SHA");
  }
  return [{ name: refName, sha }];
}

function setOutputs(evaluated: number, blocked: number): void {
  core.setOutput("evaluated-branches", String(evaluated));
  core.setOutput("blocked-branches", String(blocked));
  core.setOutput("result", blocked === 0 ? "success" : "blocked");
}

async function writeSummary(
  evaluations: BranchEvaluation[],
  notice?: string,
): Promise<void> {
  let markdown = "# compatibility.fyi gate\n\n";
  if (notice) {
    markdown += `${escapeMarkdown(notice)}\n`;
  } else {
    markdown +=
      "| Branch | Gate | Project | Dependency | Result | Range | Confidence | Verified |\n";
    markdown += "| --- | --- | --- | --- | --- | --- | --- | --- |\n";

    for (const evaluation of evaluations) {
      const decisions = evaluation.gates.flatMap((gate) => gate.decisions);
      if (decisions.length === 0) {
        markdown += `| ${escapeMarkdown(evaluation.branch)} | — | — | — | ${evaluation.state} | — | — | — |\n`;
        continue;
      }

      for (const decision of decisions) {
        markdown += `| ${escapeMarkdown(evaluation.branch)} | ${escapeMarkdown(decision.gateId)} | ${escapeMarkdown(`${decision.project} ${decision.projectVersion}`)} | ${escapeMarkdown(`${decision.dependency} ${decision.dependencyVersion}`)} | ${decision.state} | ${escapeMarkdown(decision.response?.matchedRange ?? "—")} | ${decision.response?.confidence ?? "—"} | ${decision.response?.lastVerified ?? "—"} |\n`;
      }
    }

    markdown += "\n## Details\n\n";
    for (const evaluation of evaluations) {
      markdown += `- **${escapeMarkdown(evaluation.branch)}**: ${escapeMarkdown(evaluation.description)}\n`;
      for (const gate of evaluation.gates) {
        for (const decision of gate.decisions) {
          markdown += `  - ${escapeMarkdown(decision.message)}\n`;
          for (const source of decision.response?.sources ?? []) {
            markdown += `    - [${escapeMarkdown(source.title)}](<${source.url}>)${source.accessedAt ? `, accessed ${source.accessedAt}` : ""}\n`;
          }
        }
      }
    }
  }

  await core.summary.addRaw(markdown).write();
}

function workflowRunUrl(repository: string): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  return server && runId
    ? `${server}/${repository}/actions/runs/${runId}`
    : undefined;
}

function validateStatusContext(value: string): void {
  if (!value.trim() || value.length > 100 || /[\r\n\0]/.test(value)) {
    throw new Error(
      "status-context must contain 1 to 100 characters without line breaks",
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void run();
