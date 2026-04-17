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

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import * as tar from 'tar';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig, skillsCacheDir } from '../sdk/config.js';
import { loadCredentials } from '../sdk/credentials.js';
import { fatal, log } from './common.js';
import { SkillManifestEntry } from '../sdk/types.js';
import { buildClaudeMd, claudeIgnore, cursorRules, skillToCursorMdc } from '../scaffolds/templates.js';

export interface LocalProjectConfig {
  name: string;
  category?: string;
  has_backend?: boolean;
  framework?: string;
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
  // If true, skip downloading skills (e.g. offline / CI scaffolding).
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

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'frontend'), { recursive: true });
  if (!opts.frontendOnly) {
    fs.mkdirSync(path.join(projectDir, 'backend'), { recursive: true });
  }

  const category = opts.category ?? 'general';
  const framework = opts.framework ?? 'react-vite-ts';

  const localCfg: LocalProjectConfig = {
    name,
    category,
    has_backend: !opts.frontendOnly,
    framework,
    project_id: null,
    created_at: new Date().toISOString(),
  };
  writeLocalConfig(projectDir, localCfg);

  // Scaffolding files.
  fs.writeFileSync(
    path.join(projectDir, 'CLAUDE.md'),
    buildClaudeMd({
      name,
      description: opts.description ?? '',
      category,
      frontendOnly: !!opts.frontendOnly,
    }),
  );
  fs.writeFileSync(path.join(projectDir, '.cursorrules'), cursorRules());
  fs.writeFileSync(path.join(projectDir, '.gitignore'), claudeIgnore());

  fs.writeFileSync(
    path.join(projectDir, 'frontend', 'README.md'),
    `# ${name} — frontend\n\nPlace your React + Vite + TypeScript source under this folder.\nThe AI agent will populate it on your first \`coderblock push\`.\n`,
  );
  if (!opts.frontendOnly) {
    fs.writeFileSync(
      path.join(projectDir, 'backend', 'README.md'),
      `# ${name} — backend\n\nPlace your Python + FastAPI source under this folder.\n`,
    );
  }

  if (!opts.noSkills) {
    try {
      await installSkillsForProject(projectDir, {
        category,
        frontendOnly: !!opts.frontendOnly,
      });
    } catch (err) {
      log.warn('Skill install skipped (will retry on `coderblock upgrade`).');
      if (err instanceof Error) log.dim(`  ${err.message}`);
    }
  }

  console.log();
  log.ok(`Project scaffolded at ${pc.bold(projectDir)}`);
  console.log();
  log.info('Next steps:');
  console.log(`  cd ${name}`);
  console.log('  coderblock push      # creates the project on Coderblock.ai and uploads');
  console.log('  # …or open the folder in Claude Code / Cursor first');
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
