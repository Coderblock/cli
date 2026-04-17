// Coderblock MCP server — stdio transport.
//
// Exposes the Tier 1 tools from documentation/architecture/CLI_AND_MCP.md §8.1:
//
//   coderblock_login_status
//   coderblock_list_projects
//   coderblock_project_status
//   coderblock_init_project
//   coderblock_push
//   coderblock_pull
//
// Resources:
//   coderblock://user
//   coderblock://projects
//   coderblock://projects/{id}
//   coderblock://skills/{name}
//
// The server does NOT implement its own auth — it relies on the CLI having
// been logged in already (credentials under ~/.coderblock). If credentials
// are missing, tools return a structured error and the host model is
// expected to prompt the user to run `coderblock login`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CoderblockClient } from '../sdk/client.js';
import { readConfig } from '../sdk/config.js';
import { loadCredentials } from '../sdk/credentials.js';
import { initCommand } from '../cli/init.js';
import { pushCommand } from '../cli/push.js';
import { pullCommand } from '../cli/pull.js';

const SERVER_NAME = 'coderblock';

function packageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getClient(): CoderblockClient {
  return new CoderblockClient(readConfig().api_url);
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'coderblock_login_status',
    description:
      'Return whether the local Coderblock CLI is logged in and, if so, the current user. ' +
      'Safe: read-only, performs at most one network call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'coderblock_list_projects',
    description:
      "List the caller's Coderblock.ai projects (name, id, category, timestamps). Safe: read-only.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: 'coderblock_project_status',
    description: 'Fetch details of one project by id. Safe: read-only.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'coderblock_init_project',
    description:
      'Scaffold a new local project folder with CLAUDE.md, .cursorrules, skills. ' +
      'Does NOT contact the Coderblock.ai server — use `coderblock_push` after editing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        category: { type: 'string' },
        description: { type: 'string' },
        frontend_only: { type: 'boolean' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'coderblock_push',
    description:
      'Upload the current local project to Coderblock.ai. Creates the project on first push. ' +
      'Writes files to the caller\'s Coderblock Cloud account — review before running.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name. Defaults to the cwd.' },
        trigger_preview: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'coderblock_pull',
    description:
      'Download a Coderblock.ai project into a local folder. Does not modify the server.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Target folder. Defaults to cwd.' },
        project_id: { type: 'string' },
        force: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name: string, args: Record<string, any>): Promise<{ content: any[] }> {
  switch (name) {
    case 'coderblock_login_status': {
      const creds = await loadCredentials();
      if (!creds) {
        return text("You're not logged in. Run `coderblock login` in a terminal on this machine to authenticate.");
      }
      const client = getClient();
      try {
        const me = await client.user();
        return text(`Logged in as ${me.email || me.id}. API: ${readConfig().api_url}`);
      } catch (err) {
        return text(`Credentials found but the session is not usable: ${errMsg(err)}`);
      }
    }
    case 'coderblock_list_projects': {
      const resp = await getClient().listProjects({ limit: args.limit ?? 50 });
      return json({
        count: resp.count,
        projects: resp.projects.map((p) => ({
          id: p.id, name: p.name, category: p.category, has_backend: p.has_backend,
          updated_at: p.updated_at,
        })),
      });
    }
    case 'coderblock_project_status': {
      const p = await getClient().getProject(args.project_id);
      return json({
        id: p.id, name: p.name, category: p.category,
        has_backend: p.has_backend,
        preview_url: p.preview_url, production_url: p.production_url,
        updated_at: p.updated_at,
      });
    }
    case 'coderblock_init_project': {
      await initCommand(args.name, {
        category: args.category,
        description: args.description,
        frontendOnly: !!args.frontend_only,
      });
      return text(`Scaffolded local project at ./${args.name}. Run \`coderblock_push\` when ready.`);
    }
    case 'coderblock_push': {
      await pushCommand(args.name, { triggerPreview: !!args.trigger_preview });
      return text(
        `Pushed successfully. ${args.trigger_preview ? 'Preview is rebuilding — it should be up in ~30s.' : 'Skipped preview rebuild.'}`,
      );
    }
    case 'coderblock_pull': {
      await pullCommand(args.name, {
        projectId: args.project_id,
        force: !!args.force,
      });
      return text(`Pulled into ./${args.name ?? '.'}.`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function text(msg: string) {
  return { content: [{ type: 'text', text: msg }] };
}

function json(obj: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

async function handleReadResource(uri: string): Promise<{ contents: any[] }> {
  if (uri === 'coderblock://user') {
    const me = await getClient().user();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(me, null, 2) }] };
  }
  if (uri === 'coderblock://projects') {
    const resp = await getClient().listProjects({ limit: 100 });
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(resp, null, 2) }] };
  }
  const projectMatch = uri.match(/^coderblock:\/\/projects\/([0-9a-f-]{8,})$/i);
  if (projectMatch) {
    const p = await getClient().getProject(projectMatch[1]);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(p, null, 2) }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

// ---------------------------------------------------------------------------
// Wire up server
// ---------------------------------------------------------------------------

async function main() {
  const server = new Server(
    { name: SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await handleTool(name, (args as Record<string, any>) || {});
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool '${name}' failed: ${errMsg(err)}` }],
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'coderblock://user', name: 'Current user' },
      { uri: 'coderblock://projects', name: 'My projects' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return handleReadResource(req.params.uri);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stdio MCP expects us to stay silent on stdout, errors go to stderr.
  console.error(`[coderblock-mcp] fatal: ${errMsg(err)}`);
  process.exit(1);
});
