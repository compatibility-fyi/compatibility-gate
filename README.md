# compatibility.fyi Renovate Gate

[![CI](https://github.com/compatibility-fyi/compatibility-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/compatibility-fyi/compatibility-gate/actions/workflows/ci.yml)

Prevent Renovate from opening dependency pull requests or merge requests until the proposed
repository state is supported by source-backed [compatibility.fyi](https://compatibility.fyi)
metadata. The repository provides a GitHub Action and a GitHub-hosted GitLab CI remote template.

The gate is designed for relationships Renovate cannot evaluate by itself, such as:

- whether a CloudNativePG version supports a proposed PostgreSQL operand version;
- whether a Kubernetes operator supports the Kubernetes version being proposed;
- whether a project release supports a proposed Java, database, or platform version.

The gate never queries a live cluster and never executes code from the consumer repository. It
reads declared YAML values, calls the public compatibility API, and reports a CI status.

## How it works

1. Renovate discovers an update and creates its branch.
2. Renovate's `prCreation: "status-success"` setting keeps the pull request or merge request closed
   while branch checks are pending or failing.
3. The gate reads its configuration from the repository's default branch.
4. It compares the configured project and dependency versions in the default branch with the
   resulting values in the Renovate branch.
5. For every applicable gate, it calls `https://compatibility.fyi/api/v1/check`.
6. It reports `compatibility.fyi/gate` as:
   - `success` when every applicable check passes;
   - `failure` for documented incompatibility or evidence below policy;
   - `error` for unknown compatibility, invalid configuration, or API failure.
7. Renovate opens the pull request or merge request on its next run after the combined branch
   status becomes green.

On GitHub, the workflow completes successfully after publishing a separate blocking commit status.
On GitLab, the gate job itself fails when it blocks an update. In both cases, a later scheduled
evaluation can replace the previous result on the same commit without requiring a new branch commit.

## GitHub quickstart

The recommended setup below calls the repository's reusable workflow at the job level:
`compatibility-fyi/compatibility-gate/.github/workflows/gate.yml@v1`. That wrapper creates the
runner, checks out the caller repository, and invokes the underlying Marketplace action. The direct
action reference is `compatibility-fyi/compatibility-gate@v1`; use it at the step level when you
need a custom workflow. Both forms run the same compatibility gate.

### 1. Add the gate configuration

Create `.github/compatibility-fyi.yaml` on the default branch:

```yaml
version: 1

gates:
  - id: cnpg-postgresql
    project:
      id: cloudnativepg
      version:
        files:
          - crds/cloudnative-pg/crds.yaml
        document:
          apiVersion: source.toolkit.fluxcd.io/v1
          kind: GitRepository
          metadata.name: cloudnative-pg
        value: spec.ref.tag

    dependency:
      id: postgresql
      versions:
        files:
          - apps/**/postgres/*.yaml
        document:
          apiVersion: postgresql.cnpg.io/v1
          kind: Cluster
        value: spec.imageName
        extract: ":(?<version>[^@]+)$"

    policy:
      unknown: block
      apiError: block
      minimumConfidence: high
      maximumEvidenceAgeDays: 180
```

This example reads the CloudNativePG project version from a Flux `GitRepository`, finds every
CloudNativePG `Cluster`, extracts PostgreSQL versions from `spec.imageName`, and checks the complete
state that would exist after merging the branch.

Your project selector must identify the version actually deployed. If a Helm chart version differs
from its application version, select an explicit application/image version or another source that
tracks the deployed project release.

### Combine multiple compatibility axes

Each gate describes one project-to-dependency relationship. To validate a combination, configure
one gate per relationship. The action evaluates every applicable gate against the complete proposed
repository state and publishes one combined commit status. Every applicable gate and every selected
dependency version must pass.

For example, an Advanced Cluster Management update that must work with Multicluster Engine, its
management-cluster OpenShift version, and its hosted-cluster OpenShift version uses three gates with
the same project selector and separate dependency selectors. A grouped Renovate branch is allowed
only when all three relationships pass. The action does not need a separate multi-dependency API
endpoint for this behavior.

### 2. Add the workflow

Create `.github/workflows/compatibility-fyi.yml`:

```yaml
name: compatibility.fyi gate

on:
  push:
    branches:
      - "renovate/**"
  schedule:
    - cron: "23 */6 * * *"
  workflow_dispatch:

jobs:
  gate:
    permissions:
      contents: read
      statuses: write
    uses: compatibility-fyi/compatibility-gate/.github/workflows/gate.yml@v1
    with:
      mode: ${{ github.event_name == 'push' && 'current' || 'all' }}
```

Do not add a `paths` filter. Every Renovate branch needs either a compatibility decision or an
explicit not-applicable success; a branch with no status remains pending.

For maximum supply-chain safety, replace `v1` with the full commit SHA of the release. Renovate's
`github-actions` manager can keep that SHA updated.

The scheduled trigger reevaluates existing Renovate branches when compatibility.fyi metadata
changes without a new commit on those branches.

### 3. Tell Renovate to wait

Apply `prCreation: "status-success"` globally:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "prCreation": "status-success"
}
```

Or restrict it to selected packages:

```json
{
  "packageRules": [
    {
      "matchPackageNames": ["ghcr.io/cloudnative-pg/postgresql"],
      "prCreation": "status-success"
    }
  ]
}
```

Global configuration is simpler and ensures grouped updates are also gated. It delays every
Renovate pull request until a later Renovate run sees green branch checks. Unrelated branches receive
a successful “not applicable” gate status.

## GitLab quickstart

GitLab consumes a public template directly from this GitHub repository with `include:remote`. It is
not a GitLab CI/CD Catalog component and does not require a mirrored GitLab project.

### 1. Add the gate configuration

Create `.gitlab/compatibility-fyi.yaml` on the default branch. The schema is identical to the GitHub
configuration shown above.

### 2. Include the GitHub-hosted template

Add this to `.gitlab-ci.yml`:

```yaml
---
include:
  - remote: "https://raw.githubusercontent.com/compatibility-fyi/compatibility-gate/108b0627d0e9d30cdb5f797e6daa5974a2263da3/gitlab/compatibility-gate.yml"
    integrity: "sha256-m6jAnXVEcK1PtRhcubnX9V8eqYNsmxkvNV9T6z95CI0="
```

The released README contains the exact immutable commit and SHA-256 integrity value. Do not replace
the commit with `master`: GitLab fetches remote includes without authentication, and an immutable URL
plus `integrity` prevents an upstream template change from silently changing an existing pipeline.

The template adds two `.pre` jobs:

- `compatibility.fyi/gate` evaluates Renovate branch pipelines and fails closed when compatibility
  is blocked, unknown, or cannot be checked;
- `compatibility.fyi/recheck` runs only in a scheduled default-branch pipeline and retriggers the
  existing Renovate branch pipelines.

GitLab does not create a pipeline that contains only jobs in the special `.pre` and `.post` stages.
Most projects already have an ordinary build, test, or deploy job, which satisfies this requirement.
If the gate is the repository's first CI configuration, add one job in a regular stage (or use an
existing stage from your pipeline):

```yaml
"compatibility.fyi/pipeline-anchor":
  stage: test
  image: alpine:3.23.2
  script:
    - echo "The compatibility pipeline is active."
```

### 3. Tell Renovate to wait

Use the same platform-independent Renovate setting:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "prCreation": "status-success"
}
```

Renovate creates its branch, waits for the GitLab pipeline to become green, and opens the merge
request on a later run.

### 4. Schedule automatic rechecks

A pipeline schedule is required if unchanged Renovate branches should be rechecked and unblocked
automatically. New or updated Renovate branches run the gate immediately, but a push to the default
branch or a compatibility.fyi metadata change does not rerun existing branch pipelines. Renovate
only reads their current status. Without a schedule, rechecking requires a branch update or a manual
pipeline run.

GitLab schedules are project settings and cannot be created by `include:remote`. Configure one for
each repository that uses the gate:

1. In **Settings > CI/CD > Pipeline trigger tokens**, create a trigger token.
2. Save its value under **Settings > CI/CD > Variables** as
   `COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN`, marked **Masked** and **Protected**.
3. Create a pipeline schedule targeting the protected default branch, for example every six hours.

The scheduled job uses the built-in `CI_JOB_TOKEN` only to list branches and the narrowly scoped
trigger token only to start new pipelines. The trigger token is not needed by Renovate branch jobs
and must never be written into `.gitlab-ci.yml`.

### GitLab variables

The template supports these optional project or pipeline variables:

| Variable                           | Default                            | Description                                    |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `COMPATIBILITY_FYI_CONFIG_FILE`    | `.gitlab/compatibility-fyi.yaml`   | Configuration path on the default branch.      |
| `COMPATIBILITY_FYI_API_URL`        | configuration/default              | Compatibility API endpoint override.           |
| `COMPATIBILITY_FYI_BASE_BRANCH`    | `CI_DEFAULT_BRANCH`                | Default branch override.                       |
| `COMPATIBILITY_FYI_BRANCH_PATTERN` | `renovate/**`                      | Minimatch glob used by evaluation and recheck. |
| `COMPATIBILITY_FYI_BRANCH_REGEX`   | `/^renovate\\//`                   | Matching GitLab `rules` regular expression.    |
| `COMPATIBILITY_FYI_IMAGE`          | release-specific public GHCR image | Gate container image override.                 |

When changing the branch convention, update both the glob and regular expression. You may pin
`COMPATIBILITY_FYI_IMAGE` to an image digest for an additional supply-chain lock.

## Configuration reference

The default configuration path is `.github/compatibility-fyi.yaml` on GitHub and
`.gitlab/compatibility-fyi.yaml` on GitLab. The file is always read from the default branch so a
dependency update cannot weaken its own policy.

### Top-level fields

| Field      | Required | Description                                |
| ---------- | -------- | ------------------------------------------ |
| `version`  | yes      | Configuration schema version. Must be `1`. |
| `gates`    | yes      | One or more compatibility gates.           |
| `api`      | no       | API endpoint, timeout, and retry settings. |
| `defaults` | no       | Policy inherited by every gate.            |

Unknown fields are rejected to prevent misspelled policies from silently bypassing the gate.

### Gate fields

| Field                 | Required | Description                                                          |
| --------------------- | -------- | -------------------------------------------------------------------- |
| `id`                  | yes      | Unique lowercase-dash identifier used in logs and summaries.         |
| `project.id`          | yes      | Project identifier returned by `/api/v1/projects`.                   |
| `project.version`     | yes      | Selector that must resolve to exactly one resulting project version. |
| `dependency.id`       | yes      | Dependency key from the compatibility project document.              |
| `dependency.versions` | yes      | Selector returning one or more resulting dependency versions.        |
| `policy`              | no       | Per-gate policy overrides.                                           |

If a branch removes every selected dependency, the applicable gate passes because no relationship
remains to check. If selected dependencies remain, the project selector must resolve to exactly one
version.

### Value selectors

Both `project.version` and `dependency.versions` use the same selector shape:

| Field      | Required | Description                                                                   |
| ---------- | -------- | ----------------------------------------------------------------------------- |
| `files`    | yes      | One or more Minimatch globs evaluated against repository-relative file paths. |
| `document` | no       | Dot-path/value pairs used to select documents from multi-document YAML files. |
| `value`    | yes      | Dot path to the scalar version value. Numeric array indexes are supported.    |
| `extract`  | no       | Regular expression with a named `version` group or first capture group.       |

Examples:

```yaml
# Read a direct scalar.
value: spec.ref.tag

# Extract 18.4 from ghcr.io/cloudnative-pg/postgresql:18.4.
value: spec.imageName
extract: ":(?<version>[^@]+)$"

# Select only one object from a multi-document file.
document:
  kind: HelmRelease
  metadata.name: cloudnative-pg
```

Selectors are limited to 256 matching files and 100 unique values per branch evaluation.

### Policy

| Field                    | Default | Description                                                  |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `unknown`                | `block` | `block` or `allow` when compatibility.fyi returns `unknown`. |
| `apiError`               | `block` | `block` or `allow` when the API is unavailable or malformed. |
| `minimumConfidence`      | `high`  | Minimum accepted evidence level: `low`, `medium`, or `high`. |
| `maximumEvidenceAgeDays` | unset   | Maximum age of the API response's `lastVerified` date.       |

Defaults can be shared and overridden by individual gates:

```yaml
defaults:
  unknown: block
  apiError: block
  minimumConfidence: high
  maximumEvidenceAgeDays: 180
```

### API settings

```yaml
api:
  url: https://compatibility.fyi/api/v1/check
  timeoutSeconds: 10
  retries: 2
```

Remote endpoints must use HTTPS. Plain HTTP is accepted only for localhost development.

## Reusable workflow inputs

| Input            | Default                          | Description                                |
| ---------------- | -------------------------------- | ------------------------------------------ |
| `config-file`    | `.github/compatibility-fyi.yaml` | Configuration path on the default branch.  |
| `api-url`        | configuration/default            | Compatibility API endpoint override.       |
| `mode`           | `auto`                           | `current`, `all`, or event-derived `auto`. |
| `branch-pattern` | `renovate/**`                    | Renovate branch glob.                      |
| `base-branch`    | repository default               | Base branch override.                      |
| `status-context` | `compatibility.fyi/gate`         | Published commit status context.           |

The underlying action additionally requires `github-token`; the reusable workflow supplies
`github.token` with only the declared permissions.

### Action outputs

| Output               | Description                                        |
| -------------------- | -------------------------------------------------- |
| `evaluated-branches` | Number of branches evaluated.                      |
| `blocked-branches`   | Number of branches receiving `failure` or `error`. |
| `result`             | `success` or `blocked`.                            |

The action step does not fail merely because compatibility is blocked. Consumers should use the
published commit status as the policy signal.

## Direct action usage

The reusable workflow is recommended. For custom workflows, check out the complete repository
history and invoke the action directly:

```yaml
permissions:
  contents: read
  statuses: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
    with:
      fetch-depth: 0
  - uses: compatibility-fyi/compatibility-gate@v1
    with:
      github-token: ${{ github.token }}
      mode: current
```

## Result details

Every run writes a GitHub Actions step summary containing:

- the branch and gate;
- project and dependency versions;
- compatibility result and matched range;
- confidence and `lastVerified` date;
- links to primary sources returned by compatibility.fyi.

The commit status links back to the workflow run.

GitLab writes the same decision and primary-source details to the `compatibility.fyi/gate` job log.
The job succeeds only when every applicable gate passes.

## Security model

- Policy is loaded from the default branch, not the Renovate branch.
- The action only reads Git objects and YAML; it does not execute consumer scripts or install
  consumer dependencies.
- The workflow needs only `contents: read` and `statuses: write`.
- GitLab branch jobs receive no compatibility.fyi or GitLab API secret. Only the protected scheduled
  recheck job receives its pipeline trigger token.
- API and GitHub responses are size-limited and validated before use.
- Unknown data and operational failures block by default.
- Consumer workflows should pin actions, reusable workflows, and remote templates to full commit
  SHAs. GitLab remote includes should also use `integrity`.
- Do not use `pull_request_target` for this gate.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Limitations

- Renovate still creates a branch before the gate runs. The gate prevents Renovate from opening the
  pull request.
- Renovate opens an allowed pull request on its next run, not immediately when the status turns
  green.
- This external gate evaluates the candidate Renovate selected. It cannot make Renovate fall back
  from an incompatible newest release to an older compatible release. Native Renovate enrichment
  would be needed for candidate filtering.
- The action evaluates repository-declared desired state, not the live cluster.
- If the default branch changes after a Renovate branch was created, Renovate may need to rebase the
  branch before the gate sees the new desired-state version.
- The GitLab integration is a public GitHub-hosted remote template, not a native GitLab CI/CD Catalog
  component.

## Troubleshooting

### The Renovate branch remains pending

- Confirm the workflow is present on the default branch.
- Do not use a `paths` filter.
- Confirm Actions are allowed to grant `statuses: write`.
- Check that the branch matches `renovate/**` or your configured pattern.
- Run the workflow manually with `mode: all`.

On GitLab, confirm the remote include loaded, the branch matches both
`COMPATIBILITY_FYI_BRANCH_PATTERN` and `COMPATIBILITY_FYI_BRANCH_REGEX`, and a branch pipeline was
created.

### A GitLab Renovate branch remains blocked after metadata changed

Retry its pipeline, or configure the scheduled recheck job and verify that
`COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN` is available to schedules on the protected default branch.
The failed historical pipeline remains visible, but the new successful job result is what Renovate
uses for the branch.

### Every branch reports “not applicable”

The selected project and dependency values did not change between the default branch and the
Renovate branch. Check `files`, `document`, `value`, and `extract` against the repository layout.

### The gate reports multiple project versions

`project.version` must identify exactly one resulting version. Tighten its file glob or document
selector.

### Compatibility is unknown

Inspect the project document and dependency key:

```sh
curl https://compatibility.fyi/api/v1/projects/cloudnativepg
```

Do not change `unknown` to `allow` merely to suppress missing metadata. Prefer contributing
source-backed compatibility data.

## Development

Requires Node.js 24.

```sh
npm ci
npm run validate
git diff --exit-code -- dist
```

The Node action is bundled into `dist/` so consumers do not run `npm install`. The generated bundle
must be committed with source changes.

## License

[MIT](LICENSE)
