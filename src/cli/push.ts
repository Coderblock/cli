// `coderblock push [<name>]` — upload project to Coderblock.ai.
//
// Flow:
//   1. Load .coderblock.json from the target directory (default: cwd).
//   2. If project_id is missing, create the project server-side.
//   3. Pack frontend/ + backend/ into a gzipped tar (in memory for now).
//   4. PUT /cli/projects/:id/files with the tarball.
//   5. Optionally trigger a preview.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import pc from 'picocolors';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig } from '../sdk/config.js';
import { fatal, log } from './common.js';
import { readLocalConfig, writeLocalConfig, LOCAL_CONFIG_FILENAME } from './init.js';

// Files/dirs we never upload. Server also filters defensively.
const SKIP = new Set([
  'node_modules', '__pycache__', '.git', '.venv', 'venv',
  'dist', 'build', '.next', '.turbo', '.DS_Store',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.env', '.env.local', '.env.production',
]);

export interface PushOptions {
  triggerPreview?: boolean;
}

export async function pushCommand(nameOrDir: string | undefined, opts: PushOptions = {}): Promise<void> {
  const projectDir = resolveProjectDir(nameOrDir);
  let local;
  try {
    local = readLocalConfig(projectDir);
  } catch {
    fatal(new Error(`No ${LOCAL_CONFIG_FILENAME} found in ${projectDir}. Run \`coderblock init <name>\` first.`));
  }

  const cfg = readConfig();
  const client = new CoderblockClient(cfg.api_url);

  // Create platform project if this is the first push.
  if (!local.project_id) {
    try {
      const created = await client.createProject({
        name: local.name,
        description: '',
        category: local.category ?? 'general',
        has_backend: local.has_backend !== false,
        framework: local.framework ?? 'react-vite-ts',
      });
      local.project_id = created.id;
      writeLocalConfig(projectDir, local);
      log.ok(`Created Coderblock project: ${pc.bold(created.id)}`);
    } catch (err) {
      fatal(err);
    }
  }

  // Pack the project.
  log.dim('Packaging frontend/ + backend/ …');
  const tarball = await packProject(projectDir, !!local.has_backend);
  log.dim(`  tarball size: ${formatBytes(tarball.length)}`);

  // Upload.
  try {
    const result = await client.uploadTarball(local.project_id!, tarball);
    log.ok(`Uploaded ${result.uploaded_files} files (${formatBytes(result.bytes)})`);
  } catch (err) {
    fatal(err);
  }

  // Trigger preview if requested.
  if (opts.triggerPreview) {
    try {
      const res = await client.triggerPreview(local.project_id!);
      log.ok(`Preview triggered: ${pc.cyan(res.preview_url)}`);
    } catch (err) {
      log.warn('Preview trigger failed (project was uploaded successfully).');
      if (err instanceof Error) log.dim(`  ${err.message}`);
    }
  } else {
    log.info('Open the project:');
    log.info(`  https://coderblock.ai/app/${local.project_id}`);
  }

  local.updated_at = new Date().toISOString();
  writeLocalConfig(projectDir, local);
}

function resolveProjectDir(nameOrDir: string | undefined): string {
  if (!nameOrDir) return process.cwd();
  return path.resolve(process.cwd(), nameOrDir);
}

async function packProject(projectDir: string, includeBackend: boolean): Promise<Buffer> {
  const entries: string[] = [];
  const frontendDir = path.join(projectDir, 'frontend');
  if (fs.existsSync(frontendDir)) entries.push('frontend');
  if (includeBackend) {
    const backendDir = path.join(projectDir, 'backend');
    if (fs.existsSync(backendDir)) entries.push('backend');
  }
  if (!entries.length) {
    throw new Error('Nothing to pack — no frontend/ or backend/ folder under the project.');
  }

  const tmpFile = path.join(os.tmpdir(), `coderblock-push-${Date.now()}.tgz`);
  try {
    await tar.c(
      {
        cwd: projectDir,
        gzip: true,
        file: tmpFile,
        portable: true,
        filter: (p: string) => {
          const parts = p.split(path.sep);
          for (const seg of parts) {
            if (SKIP.has(seg)) return false;
          }
          return true;
        },
      },
      entries,
    );
    return fs.readFileSync(tmpFile);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best effort
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
