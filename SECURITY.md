# Security policy

Please report vulnerabilities privately through GitHub's **Security** tab using a private
vulnerability report. Do not open a public issue for suspected vulnerabilities.

The action reads its policy from the caller repository's default branch, never from an untrusted
Renovate branch. It does not execute code from the caller repository. Consumers should pin the
action or reusable workflow to a full commit SHA and grant only `contents: read` and
`statuses: write` permissions.
