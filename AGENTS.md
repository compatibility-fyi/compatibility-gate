# Agent instructions

- The default branch is `master`.
- Use conventional commits.
- Keep the action fail-closed by default for unknown compatibility and API/configuration errors.
- Read `.github/compatibility-fyi.yaml` from the consumer repository's default branch, not from a
  Renovate branch.
- Never execute code, package scripts, or commands from a consumer repository.
- Do not log GitHub tokens or other credentials.
- Add or update tests for behavior changes.
- Run `npm ci`, `npm run validate`, and `git diff --exit-code -- dist` before publishing.
- Build `dist/` with `npm run build`; never edit it manually.
- Pin third-party GitHub Actions to full commit SHAs.
