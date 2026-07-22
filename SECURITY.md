# Security policy

Please report vulnerabilities privately through GitHub's **Security** tab using a private
vulnerability report. Do not open a public issue for suspected vulnerabilities.

The gate reads its policy from the caller repository's default branch, never from an untrusted
Renovate branch. It does not execute code from the caller repository.

GitHub consumers should pin the action or reusable workflow to a full commit SHA and grant only
`contents: read` and `statuses: write` permissions. GitLab consumers should pin the remote template
to a full commit SHA, set its `integrity`, and keep `COMPATIBILITY_FYI_GITLAB_TRIGGER_TOKEN` masked
and protected. The trigger token is required only by the optional scheduled recheck job; Renovate
branch jobs must not receive it.
