# Security policy

## Reporting a vulnerability

Please email **security@coderblock.ai** with:

- A description of the issue and, if possible, steps to reproduce.
- The commit or version you tested against.
- Your preferred channel for follow-up.

We will acknowledge receipt within **2 business days** and aim to provide a
status update (or a fix) within **14 days** for high-severity issues.

Do **not** open a public GitHub issue for anything that could compromise
user accounts or data — that includes token handling, the OAuth device flow,
the `/cli/*` endpoints, and the `cli_audit` log.

## Scope

In scope:

- This package (`@coderblock/cli`) and its two binaries (`coderblock`,
  `coderblock-mcp`).
- The public endpoints `/api/v1/oauth/*` and `/api/v1/cli/*` on
  `api.coderblock.ai`.
- The authorization page `/cli/authorize` on `coderblock.ai`.

Out of scope (handled by Coderblock's core platform policy):

- The rest of `api.coderblock.ai`.
- The Coderblock web app outside of `/cli/authorize`.
- Third-party services (Supabase, Fly.io, etc.) — report to their vendors.

## Hard rules we enforce

1. No client secret is embedded in this package.
2. Refresh tokens are stored server-side as `sha256` hashes; raw tokens never
   leave your machine after issuance.
3. Access tokens are short-lived (1h) JWTs with a dedicated audience (`cli`),
   separate from Coderblock's web session JWTs.
4. Every mutating CLI call (`push`, `pull`, `preview`, `login`, `logout`,
   session revocation) is written to an append-only audit log on the server.
5. No destructive operations (`delete`, `reset`) are exposed via CLI or MCP.
6. The MCP server uses stdio only and does not accept network connections.

## Responsible disclosure

We follow coordinated disclosure. If you need us to hold a public advisory
until a fix is live, just say so in your email — we will.
