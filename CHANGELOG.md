# Changelog

## 1.0.2 - 2026-07-21

- Fix the published action bundle so `@actions/core` is included at runtime.
- Execute a compiled-action smoke test after building to catch incomplete release bundles.

## 1.0.1 - 2026-07-21

- Clarify the difference between the recommended reusable workflow and direct Marketplace action
  invocation.

## 1.0.0 - 2026-07-21

- Evaluate configurable cross-dependency compatibility gates on Renovate branches.
- Publish fail-closed GitHub commit statuses backed by compatibility.fyi evidence.
- Support multi-document YAML, glob selectors, version extraction, confidence, and evidence-age
  policies.
- Reevaluate all Renovate branches from scheduled or manual workflows.
- Provide a reusable GitHub workflow and complete CloudNativePG/PostgreSQL example.
