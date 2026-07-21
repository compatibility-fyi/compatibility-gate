# compatibility.fyi Renovate Gate

[![CI](https://github.com/compatibility-fyi/compatibility-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/compatibility-fyi/compatibility-gate/actions/workflows/ci.yml)

Prevent Renovate from opening dependency pull requests until the proposed repository state is
supported by source-backed [compatibility.fyi](https://compatibility.fyi) metadata.

The gate is designed for relationships Renovate cannot evaluate by itself, such as:

- whether a CloudNativePG version supports a proposed PostgreSQL operand version;
- whether a Kubernetes operator supports the Kubernetes version being proposed;
- whether a project release supports a proposed Java, database, or platform version.

The action never queries a live cluster and never executes code from the consumer repository. It
reads declared YAML values, calls the public compatibility API, and publishes a GitHub commit status.

## How it works

1. Renovate discovers an update and creates its branch.
2. Renovate's `prCreation: "status-success"` setting keeps the pull request closed while branch
   checks are pending or failing.
3. This action reads `.github/compatibility-fyi.yaml` from the repository's default branch.
4. It compares the configured project and dependency versions in the default branch with the
   resulting values in the Renovate branch.
5. For every applicable gate, it calls `https://compatibility.fyi/api/v1/check`.
6. It publishes the `compatibility.fyi/gate` commit status:
   - `success` when every applicable check passes;
   - `failure` for documented incompatibility or evidence below policy;
   - `error` for unknown compatibility, invalid configuration, or API failure.
7. Renovate opens the pull request on its next run after the combined branch status becomes green.

The workflow itself completes successfully after publishing a blocking status. This is intentional:
a later scheduled evaluation can replace a previous `failure` or `error` status on the same commit
without requiring a new branch commit.

## Quickstart

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

## Configuration reference

The default configuration path is `.github/compatibility-fyi.yaml`. The file is always read from the
default branch so a dependency update cannot weaken its own policy.

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

## Security model

- Policy is loaded from the default branch, not the Renovate branch.
- The action only reads Git objects and YAML; it does not execute consumer scripts or install
  consumer dependencies.
- The workflow needs only `contents: read` and `statuses: write`.
- API and GitHub responses are size-limited and validated before use.
- Unknown data and operational failures block by default.
- Consumer workflows should pin actions and reusable workflows to full commit SHAs.
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
- The first release targets GitHub and Renovate branches. The core evaluator is intentionally
  separate so other CI platforms can be added later.

## Troubleshooting

### The Renovate branch remains pending

- Confirm the workflow is present on the default branch.
- Do not use a `paths` filter.
- Confirm Actions are allowed to grant `statuses: write`.
- Check that the branch matches `renovate/**` or your configured pattern.
- Run the workflow manually with `mode: all`.

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
