// `coderblock status [<name>]` — print current session + optional project info.

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { readConfig } from '../sdk/config.js';
import { CoderblockClient } from '../sdk/client.js';
import { loadCredentials } from '../sdk/credentials.js';
import { fatal, log, formatDate } from './common.js';
import { readLocalConfig, LOCAL_CONFIG_FILE } from './init.js';

export async function statusCommand(name?: string): Promise<void> {
  const cfg = readConfig();
  const creds = await loadCredentials();

  console.log(pc.bold('Session'));
  log.kv('api_url', cfg.api_url);
  log.kv('logged_in', creds ? 'yes' : 'no');
  if (creds) {
    log.kv('user', creds.user?.email ?? creds.user?.id ?? '(unknown)');
    log.kv('token_exp', formatDate(creds.access_token_expires_at));
  }

  if (!name && !fs.existsSync(LOCAL_CONFIG_FILE)) return;

  const projectDir = name
    ? path.resolve(process.cwd(), name)
    : process.cwd();

  let local;
  try {
    local = readLocalConfig(projectDir);
  } catch {
    if (name) {
      log.warn(`No .coderblock.json found in ${projectDir}`);
    }
    return;
  }

  console.log();
  console.log(pc.bold('Project'));
  log.kv('name', local.name);
  log.kv('project_id', local.project_id ?? '(unpushed)');
  log.kv('category', local.category ?? 'general');
  log.kv('has_backend', local.has_backend === false ? 'no' : 'yes');

  if (!local.project_id || !creds) return;

  try {
    const client = new CoderblockClient(cfg.api_url);
    const detail = await client.getProject(local.project_id);
    log.kv('created', formatDate(detail.created_at));
    log.kv('updated', formatDate(detail.updated_at));
    if (detail.preview_url) log.kv('preview', detail.preview_url);
  } catch (err) {
    fatal(err);
  }
}
