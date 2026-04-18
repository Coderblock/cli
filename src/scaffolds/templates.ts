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
