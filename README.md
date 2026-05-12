# @coderblock/cli

> Official CLI **and** MCP server for [Coderblock.ai](https://coderblock.ai).
> One npm package, two binaries:
>
> - `coderblock` — interactive command-line interface.
> - `coderblock-mcp` — stdio MCP server, so Claude Code / Cursor / Codex can
>   manage Coderblock projects directly from the chat.

## What is Coderblock.ai?

**Coderblock.ai** is a **vibe-coding platform**: a cloud runtime where you
describe what you want in natural language and dedicated **AI personal agents**
build, deploy and operate your fullstack web app for you. You don't manage
servers, databases, CI, preview environments or production deployments — the
platform does. You describe, the agents build, Coderblock runs it.

Every project on Coderblock comes with:

- A **public preview URL** (`https://<id>.coderblock.dev`) that hot-reloads as
  the agent edits files.
- A **production deployment** on Fly.io (`https://<id>.coderblock.app`) reached
  via `coderblock push`.
- A **managed Postgres** (NeonDB) injected as `DATABASE_URL` at deploy time —
  no DB provisioning, no migrations to wire by hand.
- **Auth, billing and storage** primitives plugged in by the platform when the
  agent decides the project needs them.
- A small team of **specialized AI agents** (frontend, backend, DB, security,
  UX, marketing, sales, …) that you can talk to inside the Coderblock app.

## What this CLI is for

You don't have to write code on coderblock.ai to use Coderblock. **This CLI is
the bridge between any external editor you already love and the Coderblock
runtime.** You stay in your tool, the AI agent inside your tool does the
coding, and `coderblock` ships the result to the platform.

```
┌────────────────────────────┐                       ┌────────────────────────┐
│ Your editor of choice      │   coderblock push     │ Coderblock.ai runtime  │
│ • Claude Code              │ ────────────────────▶ │ • Preview on Fly.io    │
│ • Cursor                   │                       │ • Production on Fly.io │
│ • Codex CLI / Aider / …    │ ◀──────────────────── │ • Managed Postgres     │
│ • Plain VS Code            │   coderblock pull     │ • Auth + billing       │
└────────────────────────────┘                       └────────────────────────┘
```

Concretely, `@coderblock/cli` lets you:

- **Scaffold** a Coderblock-shaped project on disk (`coderblock init`) —
  React + Vite + TypeScript frontend + FastAPI + Postgres backend, with
  `CLAUDE.md`, `.cursorrules`, skills, an env-ready backend, etc.
- **Reshape** an existing legacy project (Next.js, CRA, Astro, plain Vite, …)
  into the Coderblock layout without rewriting it by hand (`coderblock reshape`).
- **Push** the local code to Coderblock so the platform builds & deploys it.
- **Pull** an existing Coderblock project to any machine and resume work.
- **Drive everything from your editor's chat** through the bundled MCP
  server — Claude Code, Cursor and Codex CLI can call the same commands
  via natural language ("push this project", "create a new app named X").

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

# 3. Open in Claude Code / Cursor / Codex, let the agent build the app.
#    The wizard already wrote CLAUDE.md, .cursorrules, skills, a ready-to-go
#    backend/.env + backend/.env.example + backend/README.md.

# 4. When you're happy with what's on disk, push to Coderblock.
coderblock push --trigger-preview
# → https://<id>.coderblock.dev
```

To pull an existing project from Coderblock.ai to a new machine:

```bash
coderblock pull my-crm
# or: coderblock pull my-crm --project-id <uuid>
```

`pull` interactively asks whether to create a local-dev `backend/.env` for
you (default: yes, with a freshly generated `SECRET_KEY` and a placeholder
`DATABASE_URL` pointing at `localhost:5432`). Pass `--no-interactive` to take
the default without being prompted, or pick *Skip* in the prompt if you want
to wire `.env` yourself (e.g. against production env values).

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
   `backend/` with env + README, etc.).
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
| `coderblock init <name>` | Scaffold a local project folder (CLAUDE.md, skills, ready-to-run backend env, etc.). |
| `coderblock reshape <name> [source]` | Adapt an existing project (Claude Code / Cursor / Next / Vite / CRA / …) to the Coderblock layout. No LLM is called by the CLI — the editor's AI does the migration using `RESHAPE.md` + the `reshape-project` skill. |
| `coderblock push [name]` | Upload the project to Coderblock.ai. First push creates it. Filters out `.env`, `node_modules`, lockfiles, build artifacts. |
| `coderblock pull [name]` | Download a project to a local folder. Offers to create a local-dev `backend/.env` (use `--no-interactive` to take the default without prompting). |
| `coderblock upgrade [name]` | Refetch and reinstall skills at their latest versions. |
| `coderblock mcp` | Run the MCP server on stdio (used by Claude Code / Cursor / Codex). |

## Backend local development

`coderblock init` (and `reshape`) scaffold a **ready-to-run backend** so
`uvicorn main:app --reload` works out of the box — provided you have the two
prerequisites every Coderblock backend assumes:

1. **Python 3.11+** — the FastAPI + Pydantic v2 stack does *not* work on
   the Python 3.9 that ships with macOS / Xcode. On macOS:
   `brew install python@3.11` or use [pyenv](https://github.com/pyenv/pyenv).
2. **A running Postgres server** — pick any of the three options below.

The scaffold writes three files into `<project>/backend/` for you:

- **`backend/.env`** — gitignored, written at `init` time with a freshly
  generated 64-char hex `SECRET_KEY` and a placeholder `DATABASE_URL` pointing
  at `postgresql://postgres:postgres@localhost:5432/<dbname>`.
- **`backend/.env.example`** — committed reference, documents every env var
  the backend reads (the AI agent must keep this in sync with `core/config.py`).
- **`backend/README.md`** — full setup walkthrough with the commands for each
  of the three DB options below.

### Three ways to provide a local Postgres

| Option | Best when | How |
|---|---|---|
| **Docker** (recommended) | You already have Docker; want zero host install | `docker run --name coderblock-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16` then `docker exec -it coderblock-pg createdb -U postgres <dbname>` |
| **Native (Homebrew)** | You want `psql` on the host too | `brew install postgresql@16 && brew services start postgresql@16 && createdb <dbname>` (then adjust the URL — Homebrew uses your `$USER` as role, no password) |
| **NeonDB cloud** | You want zero local install, same stack as production | Sign up on [console.neon.tech](https://console.neon.tech), copy the connection string, paste it into `backend/.env` |

### Local vs. production: what changes

`backend/.env` **never leaves your machine**: it's in `.gitignore` and is
filtered out by `coderblock push` (along with `.env.local`, `.env.production`,
`node_modules`, lockfiles, build artifacts). On the Coderblock.ai side, when
the platform deploys your project to Fly.io it injects its own `DATABASE_URL`
pointing at a managed NeonDB instance, plus production values for any other
env var your backend reads. You do **not** set Neon URLs in your local file.

### What happens on `coderblock pull`

After tarball extraction, `pull` checks for `backend/.env.example` and, if
`backend/.env` is missing, asks (interactive runs only):

```
? Create backend/.env for local development?
  › 1. Local dev (recommended)  — placeholder DATABASE_URL (localhost Postgres) + fresh SECRET_KEY
    2. Skip                     — I'll create backend/.env myself later (cp .env.example .env)
```

- **Local dev** writes the same `backend/.env` shape that `init` creates,
  with a brand-new randomly generated `SECRET_KEY` per machine.
- **Skip** leaves only `backend/.env.example` and prints the
  `cp .env.example .env` reminder.
- Non-interactive runs (`--no-interactive`, CI, piped stdin) silently take
  the default → write a local-dev `.env`. Same semantics as `init`.

## What ends up on disk

```
~/.coderblock/
├── credentials                    # JSON, chmod 600
├── config.json                    # api_url, telemetry opt-in
└── cache/
    ├── skills/                    # Coderblock-managed skills (per version)
    └── external-skills/
        └── superpowers/           # obra/superpowers tarball (24h TTL)

<project>/
├── .coderblock.json               # project config (id, category, framework)
├── .cursorrules
├── .gitignore                     # ignores .env, .env.local, node_modules, …
├── CLAUDE.md                      # generated, edit freely
├── .claude/
│   ├── settings.local.json        # CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
│   └── skills/<name>/             # Claude Code / Anthropic-style skills
├── .cursor/rules/<name>.mdc
├── frontend/
│   └── README.md                  # the AI populates this folder on first turn
└── backend/                       # only if fullstack
    ├── .env                       # gitignored, scaffolded with SECRET_KEY pre-filled
    ├── .env.example               # committed reference
    └── README.md                  # local setup walkthrough (Python + Postgres)
```

If you also have `keytar` installed globally (optional), the **refresh token**
is mirrored to your OS keychain.

## Pre-installed skill packs

In addition to the Coderblock-managed catalogue served by
`/api/v1/cli/skills`, every `init` / `pull` / `reshape` (and every
`upgrade`) layers two extra sources into `<project>/.claude/skills/`:

| Source | What it adds | How |
|---|---|---|
| **[Superpowers](https://github.com/obra/superpowers)** (MIT, by Jesse Vincent) | TDD, brainstorming, systematic-debugging, subagent-driven-development, writing-plans, code-review and similar agentic workflows. | Tarball downloaded from `obra/superpowers@main` and cached locally for 24h. |
| **Bundled skills** (shipped inside this package) | `using-agent-teams` — operative reference for orchestrating Claude Code Agent Teams. | Copied straight from `src/scaffolds/bundled-skills/`. |

Each skill is also mirrored to `<project>/.cursor/rules/<name>.mdc`
so Cursor users get the same guidance.

Both sources are non-fatal: if GitHub is unreachable, `init` still
succeeds and a warning is printed (`coderblock upgrade` retries).
Pass `--no-skills` to skip everything.

### Agent Teams toggle

`coderblock init` / `pull` / `reshape` / `upgrade` also ensure
`<project>/.claude/settings.local.json` enables the experimental
Agent Teams flag (Claude Code v2.1.32+):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

The merge is non-destructive — any existing keys / env entries are
preserved.

## Security

- Open-source, published with `npm publish --provenance`.
- Uses OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE. No client
  secret is embedded in this package.
- Access tokens live 1 hour. Refresh tokens rotate on every use, 90-day TTL.
- The package performs **no destructive operations**: there is no `delete`.
  Removal of a project is only possible from the Coderblock.ai dashboard.
- `coderblock push` filters out `.env`, `.env.local`, `.env.production`,
  `node_modules`, `__pycache__`, build artifacts and lockfiles before
  uploading — secrets never leave your machine through this CLI.
- All mutating calls are logged server-side so you can audit them under
  *Settings → Developer → Authorized CLI sessions*.

Report vulnerabilities to **security@coderblock.ai**. See `SECURITY.md`.

## License

MIT — see `LICENSE`.
