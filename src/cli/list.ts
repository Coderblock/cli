// `coderblock list` — show caller's projects.

import { readConfig } from '../sdk/config.js';
import { CoderblockClient } from '../sdk/client.js';
import { fatal, log, renderTable, formatDate } from './common.js';

export async function listCommand(opts: { limit?: number } = {}): Promise<void> {
  const cfg = readConfig();
  const client = new CoderblockClient(cfg.api_url);
  try {
    const resp = await client.listProjects({ limit: opts.limit ?? 50 });
    if (!resp.projects.length) {
      log.info('No projects yet. Run `coderblock init <name>` to scaffold one.');
      return;
    }
    renderTable(
      resp.projects.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category ?? '',
        backend: p.has_backend ? 'yes' : 'no',
        updated: formatDate(p.updated_at),
      })),
      ['id', 'name', 'category', 'backend', 'updated'],
    );
  } catch (err) {
    fatal(err);
  }
}
