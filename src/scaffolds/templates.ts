// Static scaffolding templates shipped with the npm package.
//
// These mirror (a cut-down version of) apps/clients/_claude_md_template.py
// but as pure TypeScript so the CLI doesn't need to contact the server
// to produce a working project on disk.

export interface ClaudeMdInput {
  name: string;
  description?: string;
  category?: string;
  frontendOnly?: boolean;
}

export function buildClaudeMd(input: ClaudeMdInput): string {
  const { name, description, category = 'general', frontendOnly = false } = input;
  const backendSection = frontendOnly
    ? ''
    : `
## Backend

- Python 3.11+ with FastAPI, Pydantic v2.
- Deploy target: **Coderblock.ai runtime** (Fly.io). Do NOT use Supabase for
  auth/data of this *client* project — use NeonDB (PostgreSQL) for storage
  and Coderblock's OAuth relay for social login.
- Keep secrets out of the repo. Use environment variables.
`;
  const gamingNote = ['gaming', '3d', 'game'].includes(category)
    ? `\n## Gaming / 3D notes\n\nUse the \`threejs-builder\` / \`phaser-gamedev\` skills already installed.\nAssets go under \`frontend/public/assets/\`.\n`
    : '';

  return `# ${name}

${description ? `> ${description}\n` : ''}
This project is managed through the **Coderblock.ai** runtime and was
scaffolded with \`@coderblock/cli\`. It is designed to be edited inside
Claude Code / Cursor and deployed on Coderblock.ai.

## Stack

- Frontend: React + Vite + TypeScript + Tailwind (mandatory stack).
- Project category: \`${category}\`.
- Skills available to the AI agent: see \`.claude/skills/\`.

## Rules the AI agent MUST follow

- **Never** install \`@supabase/supabase-js\` or \`supabase\` in this project.
  Supabase is only used by the Coderblock.ai platform itself, not by client
  projects. For user data, use NeonDB + the Coderblock backend template.
- **Never** hardcode API keys. Use environment variables.
- Prefer the skills installed under \`.claude/skills/\` before writing code
  from scratch — they codify Coderblock's production patterns.

${backendSection}${gamingNote}

## Workflow

\`\`\`bash
# First push — creates the project on Coderblock.ai and uploads local code.
coderblock push

# Pull latest server state into this folder.
coderblock pull

# Refresh skills to latest versions.
coderblock upgrade
\`\`\`
`;
}

export function cursorRules(): string {
  return `# Cursor rules for Coderblock projects
# The agent MUST:
# - Follow rules in CLAUDE.md
# - Use skills in .cursor/rules/*.mdc as primary reference
# - Never install supabase client libraries in this project
# - Use NeonDB + Coderblock OAuth relay for auth / storage
`;
}

// -----------------------------------------------------------------------------
// Backend `.env.example` + `.env` + README
//
// Why all three?
//   - `.env.example` is committed and documents every variable `core/config.py`
//     expects, so a teammate (or the AI on a follow-up turn) can see at a
//     glance what needs setting.
//   - `.env` is gitignored (see `claudeIgnore()`) and is written WITH a real
//     randomly-generated SECRET_KEY so `uvicorn main:app` boots out of the
//     box without the user having to remember `cp .env.example .env`. The
//     DATABASE_URL points at a local Docker Postgres (postgres:postgres@
//     localhost:5432/<project>) — the user picks how to bring that DB up.
//   - `backend/README.md` ships the 5-line `docker run ...` recipe + the
//     Neon free-tier alternative, and explicitly states the local vs. cloud
//     contract: on `coderblock push`, the platform injects its own
//     DATABASE_URL on Fly.io, so the local file never leaves the machine.
//
// The AI is told (via `buildInitialPrompt`) that these three files already
// exist and must be EXTENDED (not overwritten) when it adds new env vars.
// -----------------------------------------------------------------------------

/** Sanitize a project name into a safe Postgres database identifier. */
function pgDbName(projectName: string): string {
  const cleaned = projectName.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'coderblock_app';
}

export interface BackendEnvInput {
  name: string;
  /** Pre-generated secret. When omitted, `.env.example` uses a placeholder. */
  secretKey?: string;
}

/**
 * Committed reference. Documents every variable the scaffolded backend reads.
 * NeonDB is mentioned only as a *production* note — the active default is
 * local Postgres so the project boots without an internet round-trip.
 */
export function buildBackendEnvExample(input: BackendEnvInput): string {
  const db = pgDbName(input.name);
  return `# Local backend configuration for ${input.name}.
#
# This file is COMMITTED and serves as the source of truth for which env vars
# the backend needs. Copy it to .env (already done at scaffold time) and fill
# in real values. .env itself is gitignored and never pushed to Coderblock.ai.
#
# On \`coderblock push\`, the platform injects a managed DATABASE_URL pointing
# at a NeonDB instance on the Fly.io VM — you do NOT set Neon URLs here.

# --- Database ----------------------------------------------------------------
# !! REQUIRES A RUNNING POSTGRES SERVER ON YOUR MACHINE. !!
# The URL below assumes Postgres is listening on localhost:5432 with the
# default \`postgres\` superuser. \`uvicorn main:app\` will START even without
# it, but the first DB query (auth, health check, etc.) will fail with
# "connection refused" until you bring one of these up.
#
# Option A — Docker (recommended, no install on the host):
#   docker run --name coderblock-pg -e POSTGRES_PASSWORD=postgres \\
#     -p 5432:5432 -d postgres:16
#   docker exec -it coderblock-pg createdb -U postgres ${db}
#
# Option B — Native macOS (Homebrew):
#   brew install postgresql@16
#   brew services start postgresql@16
#   createdb ${db}
#
# Option C — NeonDB cloud (same stack as production):
#   1. https://console.neon.tech → create project → copy connection string
#   2. Replace the DATABASE_URL line below with the Neon one (comment this default).
#      DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/${db}

# --- App secrets -------------------------------------------------------------
# Random 32+ char string used to sign JWTs. The scaffold pre-fills .env with
# a freshly generated value; keep this placeholder in .env.example.
SECRET_KEY=replace-me-with-a-random-32-char-string
`;
}

/**
 * Local-only `.env`. Identical structure to `.env.example` but with a real
 * SECRET_KEY pre-filled so `uvicorn` boots immediately after `pip install`.
 */
export function buildBackendEnv(input: BackendEnvInput): string {
  const db = pgDbName(input.name);
  const secret = input.secretKey || 'replace-me-with-a-random-32-char-string';
  return `# Local-only env for ${input.name}. NEVER commit this file.
# See .env.example for the documented version.

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/${db}
SECRET_KEY=${secret}
`;
}

/**
 * Full backend README. Replaces the previous one-liner. Documents the local
 * setup flow end-to-end so the user doesn't bounce off the first uvicorn run.
 */
export function buildBackendReadme(name: string): string {
  const db = pgDbName(name);
  return `# ${name} — backend

Python + FastAPI app. On \`coderblock push\` this folder is deployed to a
Fly.io VM and the Coderblock.ai runtime injects a managed NeonDB
\`DATABASE_URL\` automatically. **Locally, you bring your own Postgres.**

## Prerequisites

Before running the backend you need both of these installed on your machine:

1. **Python 3.11+** — the FastAPI + Pydantic v2 stack does NOT work on
   Python 3.9 (the version that ships with macOS / Xcode).
   - macOS: \`brew install python@3.11\` or use [pyenv](https://github.com/pyenv/pyenv)
   - Linux: \`apt install python3.11 python3.11-venv\` (Debian/Ubuntu) or the
     equivalent for your distro
   - Verify: \`python3.11 --version\` should print \`Python 3.11.x\` (or higher).

2. **A running Postgres server** — \`.env\` defaults to
   \`postgresql://postgres:postgres@localhost:5432/${db}\`, which assumes
   Postgres is listening on \`localhost:5432\`. Pick **one** of the three
   options below; without one of them, \`uvicorn\` will start fine but the
   first request that touches the DB will crash with \`connection refused\`.

### Postgres — Option A: Docker (recommended, no host install)

You need Docker (\`brew install --cask docker\` or
[Docker Desktop](https://www.docker.com/products/docker-desktop/)).

\`\`\`bash
docker run --name coderblock-pg \\
  -e POSTGRES_PASSWORD=postgres \\
  -p 5432:5432 -d postgres:16

# one-off — create the project's database
docker exec -it coderblock-pg createdb -U postgres ${db}

# verify it's up
docker ps --filter name=coderblock-pg
\`\`\`

To stop it later: \`docker stop coderblock-pg\`. To resume: \`docker start coderblock-pg\`.

### Postgres — Option B: Native macOS (Homebrew)

\`\`\`bash
brew install postgresql@16
brew services start postgresql@16

# create the project's database (this also installs the \`psql\`/\`createdb\` CLIs)
createdb ${db}

# verify it's up
brew services list | grep postgresql
\`\`\`

You may also need to adjust \`DATABASE_URL\` in \`.env\`: a native Homebrew install
typically uses your macOS username as the role and no password, so the URL
becomes \`postgresql://$USER@localhost:5432/${db}\`.

### Postgres — Option C: NeonDB cloud (same stack as production)

No local install at all — sign up at <https://console.neon.tech>, create a
project, copy the connection string and replace \`DATABASE_URL\` in
\`backend/.env\` with the Neon one. Free tier is enough for dev.

## Setup + run

> **Check that \`backend/.env\` exists.** \`coderblock init\` writes it for you
> with a real \`SECRET_KEY\` already filled in. **After \`coderblock pull\` or
> a fresh \`git clone\`, \`.env\` will be missing** (it's gitignored and never
> uploaded), so you have to recreate it:
>
> \`\`\`bash
> cd backend
> cp .env.example .env
> # then edit .env: paste a real SECRET_KEY (e.g. \`python -c "import secrets; print(secrets.token_hex(32))"\`)
> # and adjust DATABASE_URL if you're not using the default localhost Postgres.
> \`\`\`

Once the prerequisites above are in place and \`backend/.env\` exists:

\`\`\`bash
cd backend

python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

uvicorn main:app --reload --port 8000
\`\`\`

The backend creates its tables on first boot via SQLAlchemy — no \`psql\`
script required. Open <http://localhost:8000/docs> to browse the OpenAPI
schema and confirm everything is wired.

## What never leaves your machine

\`backend/.env\` is in \`.gitignore\` and is filtered out by \`coderblock push\`.
Production secrets (Neon URL, JWT key, third-party API keys) are managed by
the Coderblock.ai dashboard and injected at deploy time.
`;
}

export function claudeIgnore(): string {
  return `# Dependencies
node_modules/
__pycache__/
*.pyc

# Build
dist/
build/
.next/
.turbo/

# Env
.env
.env.local
.env.*.local

# Editor / OS
.vscode/
.DS_Store

# Coderblock
.coderblock.cache/
`;
}

// Derive a Cursor .mdc rule from a SKILL.md. We keep the skill body as-is
// and add a minimal frontmatter so Cursor picks it up.
export function skillToCursorMdc(skillMd: string): string {
  const firstHeading = (skillMd.match(/^#\s+(.+)$/m) || [])[1] || 'Coderblock skill';
  return `---
description: ${firstHeading}
alwaysApply: false
---

${skillMd}
`;
}

// -----------------------------------------------------------------------------
// First-run prompt to paste into Claude Code / Cursor / Codex after init.
//
// Mirrors the wording of apps/clients/how-to.md §6 ("Primo messaggio all'AI").
// We embed the user's description so the agent starts already grounded in
// what the project is about, and branch the scaffolding instructions on
// frontend-only / gaming so the prompt remains accurate.
// -----------------------------------------------------------------------------

export interface InitialPromptInput {
  name: string;
  description: string;
  category: string;
  frontendOnly: boolean;
}

export function buildInitialPrompt(input: InitialPromptInput): string {
  const { name, description, category, frontendOnly } = input;
  const isGaming = ['gaming', '3d', 'game'].includes(category);

  const desc = description.trim() || '(add a short description of the project here)';

  if (isGaming) {
    return [
      `Read CLAUDE.md and public/assets/assets.json. Scaffold the base project`,
      `structure and then build the game using the assets listed in the manifest.`,
      ``,
      `Project: ${name}`,
      `Description: ${desc}`,
      ``,
      `Follow the conventions in CLAUDE.md and the skills installed under`,
      `.claude/skills/ (Cursor reads them from .cursor/rules/). Do NOT install`,
      `@supabase/supabase-js — use NeonDB for storage and Coderblock's OAuth relay`,
      `for social login, exactly as described in the skills.`,
    ].join('\n');
  }

  const backendBlock = frontendOnly
    ? ''
    : [
        ``,
        `For the backend, create main.py, core/config.py, core/database.py,`,
        `requirements.txt, routes/health.py, routes/auth.py,`,
        `services/auth_service.py, models/user.py and database/base_schema.sql.`,
        ``,
        `IMPORTANT — backend env handling (already scaffolded, do NOT overwrite):`,
        `- backend/.env exists with a real SECRET_KEY and DATABASE_URL pointing`,
        `  at a local Postgres (postgresql://postgres:postgres@localhost:5432/...).`,
        `  Leave it alone — it is gitignored and local-only.`,
        `- backend/.env.example is the committed reference. Whenever you add a`,
        `  new field to core/config.py Settings, append it to BOTH .env.example`,
        `  (with a placeholder/comment) and .env (with a sensible local default),`,
        `  never just one.`,
        `- backend/README.md already documents the local setup. Do not replace it;`,
        `  only append project-specific notes if needed.`,
        `- Tables must be created on app startup via SQLAlchemy (e.g.`,
        `  Base.metadata.create_all(engine) on the FastAPI startup event), so the`,
        `  user does not need 'psql' installed. database/base_schema.sql may still`,
        `  exist as reference, but the boot path must NOT require running it.`,
      ].join('\n');

  return [
    `Read CLAUDE.md and scaffold the base project structure following the`,
    `conventions described there. Create every file marked as "exact"`,
    `(vite.config.ts, router.tsx, main.tsx, index.css, tailwind.config.js,`,
    `package.json, api.ts, postcss.config.js, tsconfig.json, index.html) and`,
    `the base Layout.tsx.${backendBlock}`,
    ``,
    `Project: ${name}`,
    `Category: ${category}`,
    `Description: ${desc}`,
    ``,
    `Use the skills installed under .claude/skills/ (Cursor reads them from`,
    `.cursor/rules/) before writing code from scratch. Do NOT install`,
    `@supabase/supabase-js — use NeonDB for storage and Coderblock's OAuth relay`,
    `for social login, exactly as described in the skills.`,
  ].join('\n');
}
