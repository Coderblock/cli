// Entrypoint for the `coderblock` binary — glue between commander and the
// individual command modules. Keep this file boring; business logic lives
// under ./*.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loginCommand } from './login.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { logoutCommand } from './logout.js';
import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { initCommand } from './init.js';
import { pushCommand } from './push.js';
import { pullCommand } from './pull.js';
import { upgradeCommand } from './upgrade.js';
import { fatal } from './common.js';

const program = new Command();

function packageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

program
  .name('coderblock')
  .description('Official CLI for Coderblock.ai — manage projects from your terminal or from Claude Code / Cursor via MCP.')
  .version(packageVersion(), '-v, --version');

program
  .command('login')
  .description('Authenticate with Coderblock.ai via the browser (OAuth device flow).')
  .option('--no-browser', 'Do not attempt to open the browser automatically.')
  .action(async (opts) => {
    try {
      await loginCommand({ noBrowser: !opts.browser });
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('logout')
  .description('Revoke this CLI session and wipe local credentials.')
  .action(async () => {
    try {
      await logoutCommand();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('list')
  .aliases(['ls'])
  .description('List your Coderblock projects.')
  .option('--limit <n>', 'How many projects to fetch (default 50).', (v) => parseInt(v, 10))
  .action(async (opts) => {
    try {
      await listCommand({ limit: opts.limit });
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('status [name]')
  .description('Show session and (optionally) project status.')
  .action(async (name: string | undefined) => {
    try {
      await statusCommand(name);
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('init <name>')
  .description('Scaffold a new local Coderblock project in a directory named <name>.')
  .option('--category <cat>', 'Project category (general, booking, ecommerce, content, dashboard, gaming, 3d, fintech, ...)', 'general')
  .option('--description <text>', 'One-line description of the project.')
  .option('--frontend-only', 'Skip creating the backend/ folder.')
  .option('--framework <name>', 'Frontend framework template.', 'react-vite-ts')
  .option('--no-skills', 'Do not download or install skills right now.')
  .action(async (name: string, opts) => {
    try {
      await initCommand(name, {
        category: opts.category,
        description: opts.description,
        frontendOnly: !!opts.frontendOnly,
        framework: opts.framework,
        noSkills: opts.skills === false,
      });
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('push [name]')
  .description('Upload the project to Coderblock.ai. Creates it on first push.')
  .option('--trigger-preview', 'Ask Coderblock to rebuild the preview after upload.')
  .action(async (name: string | undefined, opts) => {
    try {
      await pushCommand(name, { triggerPreview: !!opts.triggerPreview });
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('pull [name]')
  .description('Download a project into a local folder. Regenerates CLAUDE.md and skills.')
  .option('--project-id <uuid>', 'Pull a specific project by its id (otherwise: interactive picker).')
  .option('--force', 'Overwrite non-empty target directory.')
  .option('--no-skills', 'Do not install skills.')
  .action(async (name: string | undefined, opts) => {
    try {
      await pullCommand(name, {
        projectId: opts.projectId,
        force: !!opts.force,
        noSkills: opts.skills === false,
      });
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('upgrade [name]')
  .description('Refetch skill manifest and reinstall updated skills.')
  .action(async (name: string | undefined) => {
    try {
      await upgradeCommand(name);
    } catch (err) {
      fatal(err);
    }
  });

// `coderblock mcp` — quick alias to start the MCP server without needing a
// separate binary path. Useful for the Claude Code / Cursor config snippet.
program
  .command('mcp')
  .description('Run the Coderblock MCP server on stdio (for Claude Code / Cursor).')
  .action(async () => {
    try {
      await import('../mcp/main.js');
    } catch (err) {
      fatal(err);
    }
  });

program.parseAsync(process.argv).catch((err) => fatal(err));
