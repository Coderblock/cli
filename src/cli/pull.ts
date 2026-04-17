// `coderblock pull [<name>] [--project-id <uuid>]` — download a Coderblock.ai
// project's current source into a local folder. Supports pulling projects
// that were never initialised locally: we regenerate CLAUDE.md + .cursorrules
// + skills from the project's category/backend metadata returned in headers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import pc from 'picocolors';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig } from '../sdk/config.js';
import { fatal, log } from './common.js';
import { LocalProjectConfig, writeLocalConfig, installSkillsForProject, readLocalConfig, LOCAL_CONFIG_FILENAME } from './init.js';
import { buildClaudeMd, claudeIgnore, cursorRules } from '../scaffolds/templates.js';

export interface PullOptions {
  projectId?: string;
  force?: boolean;
  noSkills?: boolean;
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
  }
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
