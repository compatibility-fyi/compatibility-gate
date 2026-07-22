import { runGitLabGate, runGitLabRecheck } from "./gitlab.js";

async function run(): Promise<number> {
  const command = process.argv[2] ?? "evaluate";
  if (command === "evaluate") {
    return runGitLabGate();
  }
  if (command === "recheck") {
    return runGitLabRecheck();
  }
  console.error(`Unknown command ${JSON.stringify(command)}`);
  return 1;
}

void run().then((exitCode) => {
  process.exitCode = exitCode;
});
