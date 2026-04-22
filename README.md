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

## Reshape an existing project

Already have a project built with **Claude Code**, **Cursor**, Next.js, CRA,
Astro or a plain custom scaffold? Use `reshape` to adapt it to the Coderblock
layout without rewriting it by hand.

```bash
coderblock reshape my-app ~/projects/old-nextjs-app --category ecommerce
```

What this does (purely mechanical — **no LLM is invoked by the CLI**):

1. Scaffolds a fresh Coderblock project under `my-app/` (same output as
   `init`: `CLAUDE.md`, `.claude/skills/`, `.cursor/rules/`, `frontend/`,
   `backend/`).
2. Installs the dedicated **`reshape-project`** skill alongside the standard
   ones.
3. Copies the legacy source into `my-app/.reshape-source/` as a read-only
   reference, automatically stripping `node_modules/`, `.git/`, `dist/`,
   `build/`, lockfiles and — importantly — **any `.env*` file** (secrets are
   never copied).
4. Writes a self-contained `RESHAPE.md` with the migration playbook and the
   list of legacy frameworks it detected (Next.js, Vite, CRA, Astro, Svelte,
   Remix, Python/FastAPI, plain HTML, …).

Then you drive the actual migration from your editor:

```bash
cd my-app
cursor .          # or: claude
```

Paste this first message to the AI:

```
Please reshape this project. Read RESHAPE.md end-to-end, then execute the
entire migration playbook. Use .reshape-source/ as the legacy reference and
move / rewrite everything into the new layout. Do not ask me before acting
on mechanical migrations; only ask on genuine ambiguity (one question at
a time).
```

The assistant reads `RESHAPE.md` + the `reshape-project` skill, then moves
and rewrites files from `.reshape-source/` into `frontend/` and (if
fullstack) `backend/`.

Flags:

| Flag | Default | What it does |
|---|---|---|
| `--category <cat>` | `general` | Same list as `init` (`ecommerce`, `fintech`, `gaming`, …). |
| `--description "..."` | `Reshaped from <basename>` | Free-form description saved in `.coderblock.json`. |
| `--frontend-only` | auto | Force frontend-only scaffold. |
| `--fullstack` | auto | Force frontend + backend scaffold. |
| `--ide <name>` | prompt | AI assistant that will run the migration (`claude`, `cursor`, `codex`, `other`). |
| `--no-skills` | off | Skip skill installation (not recommended — the AI relies on `reshape-project`). |
| `--no-interactive` | off | Skip prompts, use defaults. |

When the migration is done and the app runs, remove the staging folder
before pushing:

```bash
rm -rf .reshape-source
coderblock push --trigger-preview
```

> `.reshape-source/` is git-ignored by the scaffold and is always filtered
> out by `coderblock push`, so it never leaves your machine.

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
| `coderblock reshape <name> [source]` | Adapt an existing project (Claude Code / Cursor / Next / Vite / CRA / …) to the Coderblock layout. No LLM is called by the CLI — the editor's AI does the migration using `RESHAPE.md` + the `reshape-project` skill. |
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
