// `coderblock reshape <name> [sourceDir]` — adapt a pre-existing project
// (Claude Code, Cursor, a bare Next.js/CRA/Astro/etc. repo) into the
// Coderblock layout so it can be pushed and edited via the platform.
//
// Flow:
//   1. Validate source dir + that the target folder does not exist.
//   2. Run the same scaffolding as `init` (creates .coderblock.json,
//      CLAUDE.md, .cursorrules, .gitignore, frontend/, backend/,
//      installs skills).
//   3. Snapshot the legacy tree into <target>/.reshape-source/ for the
//      AI assistant to read (read-only reference, git-ignored).
//   4. Write a self-contained RESHAPE.md with the full migration playbook
//      inlined — so the AI has everything it needs even without skills.
//   5. Print next-step instructions + a copy-paste prompt.

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { fatal, log } from './common.js';
import {
  installSkillsForProject,
  writeLocalConfig,
  LocalProjectConfig,
  CATEGORY_CHOICES,
  IDE_CHOICES,
  IdeChoice,
} from './init.js';
import {
  buildClaudeMd,
  claudeIgnore,
  cursorRules,
} from '../scaffolds/templates.js';
import { isInteractive, promptSelect, promptText } from './prompts.js';

export interface ReshapeOptions {
  category?: string;
  description?: string;
  frontendOnly?: boolean;
  fullstack?: boolean;
  ide?: IdeChoice;
  noInteractive?: boolean;
  noSkills?: boolean;
}

export async function reshapeCommand(
  rawName: string,
  rawSourceDir: string | undefined,
  opts: ReshapeOptions = {},
): Promise<void> {
  const name = (rawName || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) {
    fatal(
      new Error('Invalid project name. Use a simple folder-safe name, e.g. "reshaped-shop".'),
    );
  }

  const sourceDir = rawSourceDir
    ? path.resolve(rawSourceDir)
    : path.resolve(process.cwd());

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    fatal(new Error(`Source directory not found: ${sourceDir}`));
  }

  const projectDir = path.resolve(process.cwd(), name);
  if (fs.existsSync(projectDir)) {
    fatal(
      new Error(
        `Target directory already exists: ${projectDir}. Pick a different name or delete it first.`,
      ),
    );
  }
  // Refuse to nest the target INSIDE the source — confusing semantics.
  if (projectDir.startsWith(sourceDir + path.sep) || projectDir === sourceDir) {
    fatal(
      new Error(
        'Target directory must live outside the source directory (run reshape from a sibling folder).',
      ),
    );
  }

  const legacyFrameworks = detectLegacyFrameworks(sourceDir);

  // Resolve description, category, ide, scope — non-interactive-friendly.
  const resolved = await resolveReshapeInputs(name, opts, legacyFrameworks);

  console.log();
  log.info(pc.bold('Reshape plan'));
  log.dim(`  Legacy source   : ${sourceDir}`);
  log.dim(`  Target project  : ${projectDir}`);
  log.dim(`  Detected stack  : ${legacyFrameworks.length ? legacyFrameworks.join(', ') : 'generic / unknown'}`);
  log.dim(`  Project scope   : ${resolved.frontendOnly ? 'frontend-only' : 'fullstack'}`);
  log.dim(`  Category        : ${resolved.category}`);

  // ---- Scaffold (mirrors `init`) -----------------------------------------
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'frontend'), { recursive: true });
  if (!resolved.frontendOnly) {
    fs.mkdirSync(path.join(projectDir, 'backend'), { recursive: true });
  }

  const localCfg: LocalProjectConfig = {
    name,
    description: resolved.description || `Reshaped from ${path.basename(sourceDir)}`,
    category: resolved.category,
    has_backend: !resolved.frontendOnly,
    framework: 'react-vite-ts',
    ide: resolved.ide,
    project_id: null,
    created_at: new Date().toISOString(),
  };
  writeLocalConfig(projectDir, localCfg);

  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    buildClaudeMd({
      name,
      description: localCfg.description,
      category: resolved.category,
      frontendOnly: resolved.frontendOnly,
    }),
  );
  fs.writeFileSync(path.join(projectDir, '.cursorrules'), cursorRules());

  // .gitignore: reuse standard + explicitly ignore the legacy snapshot.
  const gitignore = claudeIgnore() + '\n# Reshape legacy snapshot (delete once migration is complete)\n.reshape-source/\n';
  fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore);

  // README stubs so Git doesn't leave the folders totally empty.
  fs.writeFileSync(
    path.join(projectDir, 'frontend', 'README.md'),
    `# ${name} — frontend (reshaped)\n\nThe AI assistant will migrate your legacy React/Next/Astro/... code from \`../.reshape-source/\` into this folder.\n`,
  );
  if (!resolved.frontendOnly) {
    fs.writeFileSync(
      path.join(projectDir, 'backend', 'README.md'),
      `# ${name} — backend (reshaped)\n\nThe AI assistant will migrate your legacy server code from \`../.reshape-source/\` into this folder as FastAPI + NeonDB.\n`,
    );
  }

  // ---- Copy legacy tree into .reshape-source/ ----------------------------
  const reshapeSrcDir = path.join(projectDir, '.reshape-source');
  fs.mkdirSync(reshapeSrcDir, { recursive: true });

  const { copied, skipped } = copyLegacyTree(sourceDir, reshapeSrcDir);

  // ---- Write RESHAPE.md (self-contained playbook) ------------------------
  fs.writeFileSync(
    path.join(projectDir, 'RESHAPE.md'),
    buildReshapeMd({
      name,
      sourceDir,
      legacyFrameworks,
      frontendOnly: resolved.frontendOnly,
    }),
  );

  // ---- Install skills (includes reshape-project if backend exposes it) ---
  if (!opts.noSkills) {
    try {
      await installSkillsForProject(projectDir, {
        category: resolved.category,
        frontendOnly: resolved.frontendOnly,
      });
    } catch (err) {
      log.warn('Skill install skipped (will retry on `coderblock upgrade`).');
      if (err instanceof Error) log.dim(`  ${err.message}`);
    }
  }

  // ---- Done --------------------------------------------------------------
  console.log();
  log.ok(`Project reshaped at ${pc.bold(projectDir)}`);
  log.dim(`  ${copied} file(s) snapshotted into .reshape-source/${skipped ? `, ${skipped} skipped` : ''}`);

  printReshapeNextSteps({
    projectDir,
    name,
    ide: resolved.ide,
    legacyFrameworks,
  });
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

interface ResolvedReshapeInputs {
  description: string;
  category: string;
  frontendOnly: boolean;
  ide: IdeChoice;
}

async function resolveReshapeInputs(
  name: string,
  opts: ReshapeOptions,
  legacyFrameworks: string[],
): Promise<ResolvedReshapeInputs> {
  const interactive = isInteractive() && !opts.noInteractive;

  let description = (opts.description || '').trim();
  let category = (opts.category || '').trim();
  let ide: IdeChoice | undefined = opts.ide;

  // Auto-detect scope from legacy frameworks unless flags override.
  const hasPythonLegacy = legacyFrameworks.some((f) =>
    f.toLowerCase().includes('python'),
  );
  let frontendOnly = Boolean(opts.frontendOnly);
  if (!opts.frontendOnly && !opts.fullstack) {
    frontendOnly = !hasPythonLegacy;
  }
  if (opts.fullstack) frontendOnly = false;

  if (category && !isKnownCategory(category)) {
    fatal(
      new Error(
        `Unknown --category "${category}". Valid values: ${CATEGORY_CHOICES.map((c) => c.value).join(', ')}.`,
      ),
    );
  }
  if (ide && !IDE_CHOICES.includes(ide)) {
    fatal(new Error(`Unknown --ide "${ide}". Valid values: ${IDE_CHOICES.join(', ')}.`));
  }

  if (!interactive) {
    return {
      description,
      category: category || 'general',
      frontendOnly,
      ide: ide ?? 'other',
    };
  }

  // Interactive: only ask for what we don't already have a good answer for.
  if (!description) {
    description = await promptText('One-line description of what the project does', {
      required: true,
      validate: (v) => v.length >= 3 || 'Please describe the project in a few words.',
    });
  }
  if (!category) {
    category = await promptSelect(
      'Project category',
      CATEGORY_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
      { default: 'general' },
    );
  }
  if (!opts.frontendOnly && !opts.fullstack) {
    const scope = await promptSelect<'fullstack' | 'frontend-only'>(
      'Project scope (auto-detected; confirm or change)',
      [
        { value: 'fullstack', label: 'fullstack', hint: 'React + FastAPI + Neon' },
        { value: 'frontend-only', label: 'frontend only', hint: 'just the React app' },
      ],
      { default: frontendOnly ? 'frontend-only' : 'fullstack' },
    );
    frontendOnly = scope === 'frontend-only';
  }
  if (!ide) {
    ide = await promptSelect<IdeChoice>(
      'Which AI coding assistant will run the migration?',
      IDE_CHOICES.map((v) => ({
        value: v,
        label: v === 'claude-code' ? 'Claude Code' : v === 'cursor' ? 'Cursor' : v === 'codex' ? 'OpenAI Codex CLI' : 'Other',
      })),
      { default: 'claude-code' },
    );
  }

  return { description, category, frontendOnly, ide };
}

function isKnownCategory(v: string): boolean {
  return CATEGORY_CHOICES.some((c) => c.value === v);
}

// ---------------------------------------------------------------------------
// Legacy framework detection
// ---------------------------------------------------------------------------

function detectLegacyFrameworks(sourceDir: string): string[] {
  const hits: string[] = [];
  const has = (f: string) => fs.existsSync(path.join(sourceDir, f));

  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) {
    hits.push('Next.js');
  }
  if (has('vite.config.ts') || has('vite.config.js')) hits.push('Vite');
  if (has('astro.config.mjs') || has('astro.config.ts')) hits.push('Astro');
  if (has('svelte.config.js')) hits.push('SvelteKit');
  if (has('remix.config.js')) hits.push('Remix');

  const pkgPath = path.join(sourceDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['react-scripts']) hits.push('Create React App');
      if (
        deps['react'] &&
        !hits.some((h) => ['Next.js', 'Vite', 'Create React App', 'Remix', 'Astro'].includes(h))
      ) {
        hits.push('React (unknown bundler)');
      }
    } catch {
      // ignore
    }
  }

  if (has('main.py') || has('app.py') || has('manage.py')) {
    hits.push('Python (FastAPI/Flask/Django?)');
  }
  if (has('pyproject.toml') && !hits.some((h) => h.startsWith('Python'))) {
    hits.push('Python project');
  }
  if (has('index.html') && !fs.existsSync(pkgPath)) {
    hits.push('Static HTML');
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Legacy tree copy
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.DS_Store',
]);

const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.DS_Store',
]);

const MAX_LEGACY_FILES = 10_000;

function copyLegacyTree(sourceDir: string, destDir: string): { copied: number; skipped: number } {
  let copied = 0;
  let skipped = 0;

  function walk(dir: string, rel: string) {
    if (copied + skipped >= MAX_LEGACY_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.reshape-')) {
          continue;
        }
        walk(abs, relPath);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) {
          skipped += 1;
          continue;
        }
        const destPath = path.join(destDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try {
          fs.copyFileSync(abs, destPath);
          copied += 1;
        } catch {
          skipped += 1;
        }
      } else {
        skipped += 1;
      }
    }
  }

  walk(sourceDir, '');
  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// RESHAPE.md — self-contained migration playbook
// ---------------------------------------------------------------------------

interface ReshapeMdInput {
  name: string;
  sourceDir: string;
  legacyFrameworks: string[];
  frontendOnly: boolean;
}

function buildReshapeMd(input: ReshapeMdInput): string {
  const { name, sourceDir, legacyFrameworks, frontendOnly } = input;
  const frameworks = legacyFrameworks.length ? legacyFrameworks.join(', ') : 'unknown';

  return `# RESHAPE — Migrate legacy code into Coderblock layout

Project: **${name}**
Legacy source: \`${sourceDir}\`
Detected stack: **${frameworks}**
Target scope: **${frontendOnly ? 'frontend-only' : 'fullstack'}**

---

This project was bootstrapped by \`coderblock reshape\`. A Coderblock scaffold
has already been created (\`.coderblock.json\`, \`CLAUDE.md\`, \`.cursorrules\`,
\`.gitignore\`, \`.claude/\`, \`.cursor/\`, \`frontend/\`${frontendOnly ? '' : ', `backend/`'}).
The legacy project was copied verbatim into \`./.reshape-source/\` so you
(the AI assistant) can read it with file tools without network access.

## Your job

Read this file end-to-end, then execute every step. The user expects you to
act, not to ask for confirmation on mechanical migrations.

## Target layout

\`\`\`
${name}/
├── .coderblock.json          (metadata — already written)
├── CLAUDE.md                  (conventions — already written)
├── .cursorrules               (already written)
├── .gitignore                 (already written)
├── .claude/skills/            (installed by init)
├── .cursor/rules/             (installed by init)
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       ├── components/
│       ├── lib/
│       └── hooks/
${frontendOnly ? '' : `└── backend/
    ├── main.py
    ├── requirements.txt
    ├── api/
    └── services/`}
\`\`\`

Everything outside \`frontend/\`${frontendOnly ? '' : ' and `backend/`'} is NOT
shipped to the preview server. Only those roots sync to S3.

## Playbook — execute in order

### Step 0 — Inventory

List every top-level file in \`.reshape-source/\`. Identify the source
framework (Next.js, Vite, CRA, Astro, Svelte, static HTML, Python, etc.)
and the product category. Emit a 3–6 bullet plan before writing anything.

### Step 1 — Normalize the frontend

Goal: a Vite + React 19 + TypeScript + Tailwind app that \`npm run dev\`
boots on port 5173.

- **Already Vite+React**: move \`.reshape-source/src/\` → \`frontend/src/\`,
  \`.reshape-source/public/\` → \`frontend/public/\`, configs → \`frontend/\`.
- **Next.js (App Router)**: for each \`app/<seg>/page.tsx\` create
  \`frontend/src/pages/<Seg>.tsx\` and register the route in \`App.tsx\`
  with React Router v7. Translate \`layout.tsx\` → shared layout component.
  Replace \`next/link\` → \`react-router-dom\` \`Link\`, \`next/image\` → \`<img>\`,
  \`next/navigation\` → \`useNavigate\`/\`useLocation\`. Server actions and
  \`getServerSideProps\` → client-side fetch against the FastAPI backend.
- **CRA**: move \`src/\` + \`public/\` under \`frontend/\`, drop
  \`react-scripts\`, rewrite \`package.json\` for Vite.
- **Static HTML**: wrap in a single-page Vite app, each \`<section>\`
  becomes a component under \`frontend/src/components/\`.

Use the Coderblock frontend baseline: React 19, Vite 5+, TypeScript,
Tailwind 3+, Radix UI, Framer Motion, React Router v7, Zustand, Lucide.
Keep legacy deps only if actively used.

${frontendOnly ? '' : `### Step 2 — Normalize the backend

Rule: **Coderblock backends are FastAPI + PostgreSQL (Neon) + SQLAlchemy + Alembic**.

- Translate every legacy server route into FastAPI under \`backend/api/endpoints/\`.
- Move business logic into \`backend/services/\`.
- Rewrite the database layer for \`DATABASE_URL\` → Neon. Never SQLite.
- Entrypoint: \`backend/main.py\` with \`app = FastAPI(...)\`.
- Pinned \`backend/requirements.txt\`.
- If the legacy app had auth / Stripe / email, activate the matching
  bundled skills (\`add-authentication\`, \`add-stripe-payments\`, …).

`}### Step ${frontendOnly ? '2' : '3'} — Drop platform-incompatible artifacts

- \`node_modules/\`, \`.next/\`, \`dist/\`, \`build/\`, \`.cache/\`, \`.turbo/\` — do not copy.
- \`yarn.lock\`, \`pnpm-lock.yaml\`, \`bun.lockb\` — drop; we use \`package-lock.json\` (platform-generated).
- \`.env*\` at repo root — **never copy secret values**. Write a \`.env.example\` with names only; request real values from the user via \`request_env_var\` at runtime.
- Dockerfile, docker-compose, vercel.json, netlify.toml, render.yaml, railway.json — drop (platform-managed).
- Custom CI workflows — drop unless the user explicitly asks to keep them.
- Git submodules — stop and ask the user exactly one question about how to handle them.

### Step ${frontendOnly ? '3' : '4'} — Metadata

Keep \`.coderblock.json\` keys intact but make sure they reflect reality
after the migration. Keep \`CLAUDE.md\` / \`.cursorrules\` platform sections
unchanged; only extend with feature-specific notes.

### Step ${frontendOnly ? '4' : '5'} — Verify

Mental checks before declaring done (no shell execution required):

1. \`frontend/package.json\` declares \`"dev": "vite"\` and React 19.
2. \`frontend/src/main.tsx\` exists and mounts \`<App />\`.
3. Every legacy route has a new page under \`frontend/src/pages/\`.
${frontendOnly ? '' : '4. `backend/main.py` is importable with `uvicorn main:app`.\n'}${frontendOnly ? '4' : '5'}. No \`node_modules\`, \`.env\`, \`dist\` in the new tree.
${frontendOnly ? '5' : '6'}. \`.coderblock.json\` has all required keys.

### Step ${frontendOnly ? '5' : '6'} — Final summary

Print:
- Files moved (count + examples)
- Files rewritten across frameworks (e.g. "14 Next.js pages → React Router")
- Files dropped (+ why)
- Manual follow-ups for the user (unreproducible runtimes, secrets to set)

Then tell the user: "Reshape complete — \`cd ${name}/frontend && npm run dev\`
to try the migrated app. Delete \`.reshape-source/\` once you're happy.
\`coderblock push\` when you want to sync it to Coderblock.ai."

## Guardrails

- Never invent product features that weren't in \`.reshape-source/\`.
- Never copy \`.env\` values. Request them via HIL.
- Never keep two package managers. npm only for frontend; pip for backend.
- Use file tools for every move — don't ask the user to copy things.
- Treat \`.reshape-source/\` as read-only reference.
`;
}

// ---------------------------------------------------------------------------
// Next-steps printout
// ---------------------------------------------------------------------------

interface ReshapeNextStepsInput {
  projectDir: string;
  name: string;
  ide: IdeChoice;
  legacyFrameworks: string[];
}

function printReshapeNextSteps(input: ReshapeNextStepsInput): void {
  const { projectDir, name, ide } = input;
  const relDir = path.relative(process.cwd(), projectDir) || name;

  console.log();
  log.info(pc.bold('1) Enter the reshaped project'));
  console.log(`   cd ${relDir}`);

  console.log();
  log.info(pc.bold('2) Open in your AI coding assistant'));
  switch (ide) {
    case 'claude-code':
      console.log(`   cd ${relDir} && claude`);
      log.dim('   Claude Code auto-loads CLAUDE.md and skills under .claude/skills/');
      break;
    case 'cursor':
      console.log(`   cursor ${relDir}`);
      log.dim('   Cursor auto-loads .cursorrules and rules under .cursor/rules/');
      break;
    case 'codex':
      console.log(`   cd ${relDir} && codex`);
      log.dim('   Codex reads CLAUDE.md / AGENTS.md — plus the reshape skill');
      break;
    default:
      console.log(`   Open ${relDir} in your editor of choice.`);
      log.dim('   Point the AI assistant at RESHAPE.md and .claude/skills/ before starting.');
  }

  const prompt = `Please reshape this project. Read RESHAPE.md end-to-end, then execute the entire migration playbook. Use .reshape-source/ as the legacy reference and move / rewrite everything into the new layout. Do not ask me before acting on mechanical migrations; only ask on genuine ambiguity (one question at a time).`;

  console.log();
  log.info(pc.bold('3) Paste this as your first message to the AI'));
  log.dim('   ──────────────────────────────────────────────');
  console.log(`   ${prompt}`);
  log.dim('   ──────────────────────────────────────────────');

  console.log();
  log.info(pc.bold('4) When the migration is done'));
  console.log(`   # delete the legacy snapshot once everything is moved`);
  console.log(`   rm -rf ${relDir}/.reshape-source`);
  console.log();
  console.log(`   # try the new frontend`);
  console.log(`   cd ${relDir}/frontend && npm install && npm run dev`);
  console.log();
  console.log(`   # sync to Coderblock.ai`);
  console.log(`   coderblock push`);
  console.log();
}
