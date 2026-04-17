# @coderblock/cli

> Official CLI **and** MCP server for [Coderblock.ai](https://coderblock.ai) — the
> cloud runtime for AI-generated fullstack apps.
> Designed to pair with **Claude Code** and **Cursor**: you write code in
> the editor, Coderblock gives it a home (preview URL, production deployment,
> database, auth, billing).

One npm package, two binaries:

- `coderblock` — interactive command-line interface.
- `coderblock-mcp` — stdio MCP server, so Claude Code / Cursor can manage
  Coderblock projects directly from the chat.

## Install

```bash
npm i -g @coderblock/cli
```

Node 18.17+ required.

## Quickstart

```bash
# 1. Authenticate (opens a browser for a one-click approval).
coderblock login

# 2. Scaffold a new project locally.
coderblock init my-crm --category booking

cd my-crm

# 3. Open in Claude Code / Cursor, edit the code, then push.
coderblock push --trigger-preview
# → https://preview-abc123.coderblock.dev
```

To pull an existing project from Coderblock.ai to a new machine:

```bash
coderblock pull my-crm
# or: coderblock pull my-crm --project-id <uuid>
```

Drop-in MCP config snippets live under [`examples/`](./examples).

## Use from Claude Code

Add to `~/.claude/mcp_config.json`:

```json
{
  "mcpServers": {
    "coderblock": {
      "command": "npx",
      "args": ["-y", "@coderblock/cli", "mcp"]
    }
  }
}
```

## Use from Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "coderblock": {
      "command": "npx",
      "args": ["-y", "@coderblock/cli", "mcp"]
    }
  }
}
```

Once configured, Claude Code / Cursor can use tools like
`coderblock_list_projects`, `coderblock_push`, `coderblock_pull` — the user
just asks in natural language.

## Commands

| Command | What it does |
|---|---|
| `coderblock login` | OAuth 2.0 device flow (RFC 8628 + PKCE) through your browser. |
| `coderblock logout` | Revoke the session on the server and wipe local creds. |
| `coderblock list` | Show your Coderblock projects. |
| `coderblock status [name]` | Show session info and (optionally) a project. |
| `coderblock init <name>` | Scaffold a local project folder (CLAUDE.md, skills, etc.). |
| `coderblock push [name]` | Upload the project to Coderblock.ai. First push creates it. |
| `coderblock pull [name]` | Download a project to a local folder. |
| `coderblock upgrade [name]` | Refetch and reinstall skills at their latest versions. |
| `coderblock mcp` | Run the MCP server on stdio (used by Claude Code / Cursor). |

## What ends up on disk

```
~/.coderblock/
├── credentials            # JSON, chmod 600
├── config.json            # api_url, telemetry opt-in
└── skills-cache/          # downloaded skills (per project version)

<project>/
├── .coderblock.json       # project config (id, category, framework)
├── .cursorrules
├── .gitignore
├── CLAUDE.md              # generated, do edit freely
├── .claude/skills/<name>/ # Claude Code / Anthropic-style skill
├── .cursor/rules/<name>.mdc
├── frontend/              # React + Vite + TS
└── backend/               # Python + FastAPI (unless --frontend-only)
```

If you also have `keytar` installed globally (optional), the **refresh token**
is mirrored to your OS keychain.

## Security

- Open-source, published with `npm publish --provenance`.
- Uses OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE. No client
  secret is embedded in this package.
- Access tokens live 1 hour. Refresh tokens rotate on every use, 90-day TTL.
- The package performs **no destructive operations**: there is no `delete`.
  Removal of a project is only possible from the Coderblock.ai dashboard.
- All mutating calls are logged server-side so you can audit them under
  *Settings → Developer → Authorized CLI sessions*.

Report vulnerabilities to **security@coderblock.ai**. See `SECURITY.md`.

## License

MIT — see `LICENSE`.
