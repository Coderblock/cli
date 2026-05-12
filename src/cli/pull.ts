// `coderblock pull [<name>] [--project-id <uuid>]` — download a Coderblock.ai
// project's current source into a local folder. Supports pulling projects
// that were never initialised locally: we regenerate CLAUDE.md + .cursorrules
// + skills from the project's category/backend metadata returned in headers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import pc from 'picocolors';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig } from '../sdk/config.js';
import { fatal, log } from './common.js';
import { LocalProjectConfig, writeLocalConfig, installSkillsForProject, installExtraSkills, readLocalConfig, LOCAL_CONFIG_FILENAME } from './init.js';
import { buildBackendEnv, buildClaudeMd, claudeIgnore, cursorRules } from '../scaffolds/templates.js';
import { writeClaudeSettingsLocal } from '../scaffolds/external-skills.js';
import { isInteractive, promptSelect } from './prompts.js';

export interface PullOptions {
  projectId?: string;
  force?: boolean;
  noSkills?: boolean;
  /** Force non-interactive mode even on a TTY. */
  noInteractive?: boolean;
}

export async function pullCommand(nameOrDir: string | undefined, opts: PullOptions = {}): Promise<void> {
  const cfg = readConfig();
  const client = new CoderblockClient(cfg.api_url);

  // Resolve target directory.
  const targetDir = nameOrDir
    ? path.resolve(process.cwd(), nameOrDir)
    : process.cwd();

  // Resolve project_id:
  //   1. --project-id flag wins.
  //   2. If a .coderblock.json exists in target, use its id.
  //   3. Otherwise interactive picker (list and prompt).
  let projectId = opts.projectId;
  let localCfg: LocalProjectConfig | null = null;

  try {
    if (fs.existsSync(path.join(targetDir, LOCAL_CONFIG_FILENAME))) {
      localCfg = readLocalConfig(targetDir);
      if (!projectId && localCfg.project_id) projectId = localCfg.project_id;
    }
  } catch {
    // ignore — we'll treat it as an uninitialized pull
  }

  if (!projectId) {
    try {
      const list = await client.listProjects({ limit: 50 });
      if (!list.projects.length) {
        fatal(new Error('No Coderblock projects found for this user.'));
      }
      console.log('Select a project to pull:');
      list.projects.forEach((p, i) => {
        console.log(`  ${i + 1}) ${pc.bold(p.name)}  ${pc.dim(p.id)}`);
      });
      const picked = await promptIndex(list.projects.length);
      projectId = list.projects[picked - 1].id;
    } catch (err) {
      fatal(err);
    }
  }

  // Ensure target directory exists (create if missing).
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  } else if (!opts.force) {
    const contents = fs.readdirSync(targetDir);
    // Tolerate the .coderblock.json in place; refuse the rest.
    const meaningful = contents.filter((e) => e !== LOCAL_CONFIG_FILENAME);
    if (meaningful.length > 0) {
      fatal(
        new Error(
          `Target directory ${targetDir} is not empty. Pass --force to overwrite.`,
        ),
      );
    }
  }

  // Download tarball.
  log.dim('Downloading project archive…');
  let buffer: Buffer;
  let category = 'general';
  let hasBackend = true;
  let projectName: string = nameOrDir ?? 'coderblock-project';
  try {
    const resp = await client.downloadTarballBuffer(projectId!);
    buffer = resp.buffer;
    category = String(resp.headers['x-coderblock-category'] ?? category);
    hasBackend = String(resp.headers['x-coderblock-has-backend'] ?? 'true') !== 'false';

    // Try to reach server for canonical project name.
    try {
      const detail = await client.getProject(projectId!);
      projectName = detail.name || projectName;
    } catch {
      // non-fatal
    }
  } catch (err) {
    fatal(err);
  }

  const tmpFile = path.join(os.tmpdir(), `coderblock-pull-${Date.now()}.tgz`);
  fs.writeFileSync(tmpFile, buffer!);
  try {
    await tar.x({ file: tmpFile, cwd: targetDir });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }

  // Rebuild meta files (overwrite stale versions).
  const mergedCfg: LocalProjectConfig = {
    ...(localCfg ?? {}),
    name: projectName,
    category,
    has_backend: hasBackend,
    framework: localCfg?.framework ?? 'react-vite-ts',
    // Always pin to the freshly-resolved project id, even if the local file
    // had a stale one.
    project_id: projectId!,
    updated_at: new Date().toISOString(),
  };
  writeLocalConfig(targetDir, mergedCfg);

  fs.writeFileSync(
    path.join(targetDir, 'CLAUDE.md'),
    buildClaudeMd({
      name: projectName,
      category,
      frontendOnly: !hasBackend,
    }),
  );
  fs.writeFileSync(path.join(targetDir, '.cursorrules'), cursorRules());
  if (!fs.existsSync(path.join(targetDir, '.gitignore'))) {
    fs.writeFileSync(path.join(targetDir, '.gitignore'), claudeIgnore());
  }

  log.ok(`Pulled project into ${pc.bold(targetDir)}`);

  // Install skills matching the project category.
  if (!opts.noSkills) {
    try {
      await installSkillsForProject(targetDir, {
        category,
        frontendOnly: !hasBackend,
      });
    } catch (err) {
      log.warn('Skill install skipped (run `coderblock upgrade` later).');
      if (err instanceof Error) log.dim(`  ${err.message}`);
    }

    await installExtraSkills(targetDir);
  }

  // Always (re)write `.claude/settings.local.json` so the agent-teams
  // toggle is present even on machines that pulled the project for the
  // first time.
  writeClaudeSettingsLocal(targetDir);

  // `coderblock push` filters .env from the uploaded tarball (and `.env`
  // is gitignored anyway), so after every pull the backend will be missing
  // `backend/.env`. Offer to regenerate a local-dev version so the user
  // can `uvicorn` immediately; otherwise they can configure it manually.
  // The prompt is gated on `hasBackend` + TTY to stay safe in CI / scripted
  // contexts.
  if (hasBackend) {
    await maybeCreateBackendEnv(targetDir, projectName, !!opts.noInteractive);
  }
}

/**
 * Offer to create `backend/.env` from the just-pulled `.env.example`. No-op
 * when the project has no backend, when `.env.example` is missing, or when
 * `.env` already exists (we never overwrite a user file).
 *
 * Interactive runs prompt the user with two choices: a "local dev" default
 * that writes a placeholder `DATABASE_URL` + a freshly generated
 * `SECRET_KEY`, or "skip" so they can decide later (e.g. when they intend
 * to wire the pulled project to production env values manually).
 *
 * Non-interactive runs (`--no-interactive` or no TTY) silently fall back to
 * the default — matches `init.ts` semantics: "skip the prompts, take the
 * recommended option". This keeps `uvicorn main:app` bootable after a CI
 * pull without surprising the user.
 */
async function maybeCreateBackendEnv(
  projectDir: string,
  projectName: string,
  noInteractive: boolean,
): Promise<void> {
  const backendDir = path.join(projectDir, 'backend');
  const envExamplePath = path.join(backendDir, '.env.example');
  const envPath = path.join(backendDir, '.env');

  if (!fs.existsSync(backendDir)) return;
  if (!fs.existsSync(envExamplePath)) return;
  if (fs.existsSync(envPath)) return;

  const useDefault = noInteractive || !isInteractive();
  let choice: 'local' | 'skip' = 'local';

  if (!useDefault) {
    console.log();
    choice = await promptSelect<'local' | 'skip'>(
      'Create backend/.env for local development?',
      [
        {
          value: 'local',
          label: 'Local dev (recommended)',
          hint: 'placeholder DATABASE_URL (localhost Postgres) + fresh SECRET_KEY',
        },
        {
          value: 'skip',
          label: 'Skip',
          hint: "I'll create backend/.env myself later (cp .env.example .env)",
        },
      ],
      { default: 'local' },
    );
  }

  if (choice !== 'local') {
    log.dim('  Skipped. Run: cp backend/.env.example backend/.env  when ready.');
    return;
  }

  const secretKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(envPath, buildBackendEnv({ name: projectName, secretKey }));
  log.ok('Created backend/.env with a freshly generated SECRET_KEY.');
  log.dim(
    `  DATABASE_URL points at localhost Postgres — see ${pc.bold('backend/README.md')} for setup.`,
  );
}

async function promptIndex(max: number): Promise<number> {
  return new Promise((resolve) => {
    process.stdout.write(`Enter number [1-${max}]: `);
    const buf: Buffer[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data: string | Buffer) => {
      buf.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      const s = Buffer.concat(buf).toString('utf8').trim();
      const n = parseInt(s, 10);
      if (Number.isFinite(n) && n >= 1 && n <= max) {
        resolve(n);
      } else {
        console.log('Invalid choice.');
        process.exit(1);
      }
    });
  });
}
