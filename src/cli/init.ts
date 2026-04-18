// `coderblock init <name>` — scaffolds a new local project that can later be
// pushed to Coderblock.ai with `coderblock push`.
//
// Output layout (matches apps/clients/manage.py behaviour):
//
//   <name>/
//     .coderblock.json
//     .cursorrules
//     .gitignore
//     CLAUDE.md
//     .claude/skills/<skill>/SKILL.md     (fetched from server)
//     .cursor/rules/<skill>.mdc           (derived from SKILL.md)
//     frontend/
//     backend/                             (unless --frontend-only)
//
// When stdin is a TTY and the required pieces of information are missing,
// we run a short interactive wizard (description, category, IDE of choice,
// frontend-only). In non-TTY contexts (CI, piped input, `--no-interactive`)
// we fall back to defaults and only the positional `<name>` is required.

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import * as tar from 'tar';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig, skillsCacheDir } from '../sdk/config.js';
import { loadCredentials } from '../sdk/credentials.js';
import { fatal, log } from './common.js';
import { SkillManifestEntry } from '../sdk/types.js';
import {
  buildClaudeMd,
  buildInitialPrompt,
  claudeIgnore,
  cursorRules,
  skillToCursorMdc,
} from '../scaffolds/templates.js';
import { isInteractive, promptSelect, promptText } from './prompts.js';

// Supported IDEs for the "which editor do you use?" step. We keep the
// list closed because we use the value later to print IDE-specific
// instructions.
export const IDE_CHOICES = ['claude-code', 'cursor', 'codex', 'other'] as const;
export type IdeChoice = (typeof IDE_CHOICES)[number];

export const CATEGORY_CHOICES = [
  { value: 'general', label: 'general', hint: 'Generic web app (default)' },
  { value: 'business', label: 'business', hint: 'Dashboards, admin panels, SaaS' },
  { value: 'ecommerce', label: 'ecommerce', hint: 'Online store, marketplace (+ Stripe)' },
  { value: 'fintech', label: 'fintech', hint: 'Banking, payments (+ Stripe)' },
  { value: 'booking', label: 'booking', hint: 'Reservations, scheduling (+ Stripe)' },
  { value: 'social', label: 'social', hint: 'Social network, messaging' },
  { value: 'content', label: 'content', hint: 'CMS, blog, portfolio' },
  { value: 'gaming', label: 'gaming', hint: '2D browser games (Phaser)' },
  { value: '3d', label: '3d', hint: '3D configurators / experiences (Three.js)' },
  { value: 'wellness', label: 'wellness', hint: 'Health, fitness' },
] as const;

const IDE_LABELS: Record<IdeChoice, { label: string; hint: string }> = {
  'claude-code': { label: 'Claude Code', hint: 'reads CLAUDE.md + .claude/skills/' },
  cursor: { label: 'Cursor', hint: 'reads .cursorrules + .cursor/rules/' },
  codex: { label: 'OpenAI Codex CLI', hint: 'reads CLAUDE.md + AGENTS.md' },
  other: { label: 'Other / decide later', hint: 'no editor-specific hint printed' },
};

export interface LocalProjectConfig {
  name: string;
  description?: string;
  category?: string;
  has_backend?: boolean;
  framework?: string;
  ide?: IdeChoice;
  project_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export const LOCAL_CONFIG_FILENAME = '.coderblock.json';
export const LOCAL_CONFIG_FILE = path.resolve(process.cwd(), LOCAL_CONFIG_FILENAME);

export function readLocalConfig(dir: string): LocalProjectConfig {
  const p = path.join(dir, LOCAL_CONFIG_FILENAME);
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw) as LocalProjectConfig;
}

export function writeLocalConfig(dir: string, cfg: LocalProjectConfig): void {
  const p = path.join(dir, LOCAL_CONFIG_FILENAME);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

export interface InitOptions {
  category?: string;
  description?: string;
  frontendOnly?: boolean;
  framework?: string;
  ide?: IdeChoice;
  /** Force a non-interactive run even when stdin is a TTY. */
  noInteractive?: boolean;
  /** If true, skip downloading skills (e.g. offline / CI scaffolding). */
  noSkills?: boolean;
}

export async function initCommand(rawName: string, opts: InitOptions = {}): Promise<void> {
  const name = rawName.trim();
  if (!name || name.includes('/') || name.includes('\\')) {
    fatal(new Error('Invalid project name. Use a simple folder-safe name, e.g. "my-crm".'));
  }

  const projectDir = path.resolve(process.cwd(), name);
  if (fs.existsSync(projectDir)) {
    fatal(new Error(`Directory already exists: ${projectDir}`));
  }

  // Resolve the four "interactive" inputs. We only prompt for values the
  // user did NOT pass on the command line, so `--category gaming` + a
  // wizard asking the other questions works as expected.
  const resolved = await resolveInitInputs(name, opts);

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'frontend'), { recursive: true });
  if (!resolved.frontendOnly) {
    fs.mkdirSync(path.join(projectDir, 'backend'), { recursive: true });
  }

  const framework = opts.framework ?? 'react-vite-ts';

  const localCfg: LocalProjectConfig = {
    name,
    description: resolved.description || undefined,
    category: resolved.category,
    has_backend: !resolved.frontendOnly,
    framework,
    ide: resolved.ide,
    project_id: null,
    created_at: new Date().toISOString(),
  };
  writeLocalConfig(projectDir, localCfg);

  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    buildClaudeMd({
      name,
      description: resolved.description,
      category: resolved.category,
      frontendOnly: resolved.frontendOnly,
    }),
  );
  fs.writeFileSync(path.join(projectDir, '.cursorrules'), cursorRules());
  fs.writeFileSync(path.join(projectDir, '.gitignore'), claudeIgnore());

  fs.writeFileSync(
    path.join(projectDir, 'frontend', 'README.md'),
    `# ${name} — frontend\n\nPlace your React + Vite + TypeScript source under this folder.\nThe AI agent will populate it on your first \`coderblock push\`.\n`,
  );
  if (!resolved.frontendOnly) {
    fs.writeFileSync(
      path.join(projectDir, 'backend', 'README.md'),
      `# ${name} — backend\n\nPlace your Python + FastAPI source under this folder.\n`,
    );
  }

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

  console.log();
  log.ok(`Project scaffolded at ${pc.bold(projectDir)}`);

  printNextSteps({
    projectDir,
    name,
    ide: resolved.ide,
    description: resolved.description,
    category: resolved.category,
    frontendOnly: resolved.frontendOnly,
  });
}

// -----------------------------------------------------------------------------
// Input resolution (flags + interactive wizard)
// -----------------------------------------------------------------------------

interface ResolvedInputs {
  description: string;
  category: string;
  frontendOnly: boolean;
  ide: IdeChoice;
}

async function resolveInitInputs(
  name: string,
  opts: InitOptions,
): Promise<ResolvedInputs> {
  const interactive = isInteractive() && !opts.noInteractive;

  // Start with whatever the user passed on the CLI.
  let description = opts.description?.trim() || '';
  let category = opts.category?.trim() || '';
  let frontendOnly = Boolean(opts.frontendOnly);
  let ide: IdeChoice | undefined = opts.ide;

  if (category && !isKnownCategory(category)) {
    fatal(
      new Error(
        `Unknown --category "${category}". Valid values: ${CATEGORY_CHOICES.map((c) => c.value).join(', ')}.`,
      ),
    );
  }
  if (ide && !IDE_CHOICES.includes(ide)) {
    fatal(
      new Error(
        `Unknown --ide "${ide}". Valid values: ${IDE_CHOICES.join(', ')}.`,
      ),
    );
  }

  if (!interactive) {
    // Non-TTY fallback: description stays empty if not passed (we'll
    // still scaffold a valid project), category defaults to general.
    return {
      description,
      category: category || 'general',
      frontendOnly,
      ide: ide ?? 'other',
    };
  }

  // -- Interactive wizard --------------------------------------------------
  console.log();
  console.log(pc.bold(`Setting up ${pc.cyan(name)}`));
  console.log(pc.dim('Press Enter to accept the default shown in parentheses.'));
  console.log();

  if (!description) {
    description = await promptText(
      'Short description of the project',
      {
        required: true,
        validate: (v) =>
          v.length >= 3 || 'Please describe the project in at least a few words.',
      },
    );
  }

  if (!category) {
    category = await promptSelect(
      'Project category',
      CATEGORY_CHOICES.map((c) => ({
        value: c.value,
        label: c.label,
        hint: c.hint,
      })),
      { default: 'general' },
    );
  }

  // Only ask about --frontend-only if the user didn't pass it explicitly.
  // When the flag is already set we trust it.
  if (!opts.frontendOnly) {
    const scope = await promptSelect<'fullstack' | 'frontend-only'>(
      'Project scope',
      [
        {
          value: 'fullstack',
          label: 'fullstack',
          hint: 'frontend + backend (FastAPI + NeonDB)',
        },
        {
          value: 'frontend-only',
          label: 'frontend only',
          hint: 'just the React + Vite app',
        },
      ],
      { default: 'fullstack' },
    );
    frontendOnly = scope === 'frontend-only';
  }

  if (!ide) {
    ide = await promptSelect<IdeChoice>(
      'Which AI coding assistant will you use on this project?',
      IDE_CHOICES.map((v) => ({
        value: v,
        label: IDE_LABELS[v].label,
        hint: IDE_LABELS[v].hint,
      })),
      { default: 'claude-code' },
    );
  }

  return { description, category, frontendOnly, ide };
}

function isKnownCategory(v: string): boolean {
  return CATEGORY_CHOICES.some((c) => c.value === v);
}

// -----------------------------------------------------------------------------
// Next-steps printout (IDE-specific + exact first prompt)
// -----------------------------------------------------------------------------

interface NextStepsInput {
  projectDir: string;
  name: string;
  ide: IdeChoice;
  description: string;
  category: string;
  frontendOnly: boolean;
}

function printNextSteps(input: NextStepsInput): void {
  const { projectDir, name, ide, description, category, frontendOnly } = input;
  const relDir = path.relative(process.cwd(), projectDir) || name;

  console.log();
  log.info(pc.bold('1) Enter the project folder'));
  console.log(`   cd ${relDir}`);

  console.log();
  log.info(pc.bold('2) Open it in your AI coding assistant'));

  switch (ide) {
    case 'claude-code':
      console.log(`   cd ${relDir} && claude`);
      console.log(
        pc.dim(
          '   Claude Code auto-loads CLAUDE.md and skills under .claude/skills/',
        ),
      );
      break;
    case 'cursor':
      console.log(`   cursor ${relDir}`);
      console.log(
        pc.dim(
          '   Cursor auto-loads .cursorrules and rules under .cursor/rules/',
        ),
      );
      break;
    case 'codex':
      console.log(`   cd ${relDir} && codex`);
      console.log(
        pc.dim(
          '   Codex reads CLAUDE.md / AGENTS.md — the skills under .claude/skills/ describe project conventions',
        ),
      );
      break;
    case 'other':
      console.log(`   Open ${relDir} in your editor of choice.`);
      console.log(
        pc.dim(
          '   Point the AI assistant at CLAUDE.md and .claude/skills/ before starting.',
        ),
      );
      break;
  }

  const initialPrompt = buildInitialPrompt({
    name,
    description,
    category,
    frontendOnly,
  });

  console.log();
  log.info(pc.bold('3) Paste this as the first message to the AI'));
  console.log(pc.dim('   ──────────────────────────────────────────────'));
  for (const line of initialPrompt.split('\n')) {
    console.log(`   ${line}`);
  }
  console.log(pc.dim('   ──────────────────────────────────────────────'));

  console.log();
  log.info(pc.bold('4) When you are ready to sync to Coderblock.ai'));
  console.log(`   coderblock push      ${pc.dim('# creates the project and uploads')}`);
  console.log();
}

// -----------------------------------------------------------------------------
// Skill installation
// -----------------------------------------------------------------------------

export async function installSkillsForProject(
  projectDir: string,
  opts: { category?: string; frontendOnly?: boolean } = {},
): Promise<string[]> {
  const creds = await loadCredentials();
  if (!creds) {
    // No creds — skills require an authenticated call. Non-fatal on init.
    throw new Error('Not logged in — run `coderblock login` to install skills.');
  }
  const cfg = readConfig();
  const client = new CoderblockClient(cfg.api_url);

  const manifest = await client.listSkills({
    category: opts.category,
    frontend_only: opts.frontendOnly,
  });
  const installed: string[] = [];

  for (const skill of manifest.skills) {
    try {
      await installSingleSkill(client, projectDir, skill);
      installed.push(skill.name);
    } catch (err) {
      log.warn(`Failed to install skill '${skill.name}'`);
      if (err instanceof Error) log.dim(`  ${err.message}`);
    }
  }

  if (installed.length) {
    log.ok(`Installed ${installed.length} skill${installed.length === 1 ? '' : 's'}: ${installed.join(', ')}`);
  }
  return installed;
}

async function installSingleSkill(
  client: CoderblockClient,
  projectDir: string,
  skill: SkillManifestEntry,
): Promise<void> {
  const cacheDir = path.join(skillsCacheDir(), `${skill.name}@${skill.version}`);
  fs.mkdirSync(cacheDir, { recursive: true });

  // Check cache — if already extracted, skip download.
  const cacheMarker = path.join(cacheDir, '.ok');
  if (!fs.existsSync(cacheMarker)) {
    const buf = await client.downloadSkill(skill.name, skill.version);
    const tarballPath = path.join(cacheDir, 'archive.tgz');
    fs.writeFileSync(tarballPath, buf);
    await tar.x({ file: tarballPath, cwd: cacheDir });
    fs.writeFileSync(cacheMarker, new Date().toISOString());
  }

  // Copy to .claude/skills/<name>/ inside the project.
  const claudeDest = path.join(projectDir, '.claude', 'skills', skill.name);
  fs.mkdirSync(claudeDest, { recursive: true });
  copyRecursive(path.join(cacheDir, skill.name), claudeDest);

  // Derive .cursor/rules/<name>.mdc from SKILL.md.
  const skillMdPath = path.join(claudeDest, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    const cursorDir = path.join(projectDir, '.cursor', 'rules');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, `${skill.name}.mdc`), skillToCursorMdc(skillMd));
  }
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
