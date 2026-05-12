// External + bundled skills installer.
//
// Two extra "always-on" skill sources, layered ON TOP of the regular
// Coderblock-managed skills returned by `/api/v1/cli/skills`:
//
//   1. **Superpowers** — Jesse Vincent's agentic skills framework
//      (https://github.com/obra/superpowers, MIT). We download the
//      `main` branch tarball from GitHub on demand, cache it under
//      `~/.coderblock/cache/external-skills/superpowers/`, and copy
//      every folder under `skills/` into the project's
//      `.claude/skills/<name>/`. A matching `.cursor/rules/<name>.mdc`
//      is derived from each `SKILL.md`.
//
//   2. **Bundled skills** — small skills shipped inside this npm
//      package under `src/scaffolds/bundled-skills/<name>/SKILL.md`.
//      Currently: `using-agent-teams` (Claude Code Agent Teams
//      reference). They install the same way as Superpowers but
//      without the network round-trip.
//
// In addition, this module owns the project's `.claude/settings.local.json`
// — specifically it ensures `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is
// enabled so the Agent Teams feature works out of the box. The merge is
// non-destructive: existing keys/env entries are preserved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import * as tar from 'tar';
import { skillToCursorMdc } from './templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// At runtime we live in `dist/scaffolds/external-skills.js`; the bundled
// skills ship as raw markdown under `src/scaffolds/bundled-skills/`
// (whitelisted in package.json `files`). Two `..` jumps reach the
// package root regardless of build vs. source layout.
const BUNDLED_SKILLS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'scaffolds',
  'bundled-skills',
);

// `codeload.github.com` returns the gzipped tarball directly without
// the redirect that `github.com/.../archive/...` would issue, so
// `undici.request` (no redirect-follow) is enough.
const SUPERPOWERS_TARBALL_URL =
  'https://codeload.github.com/obra/superpowers/tar.gz/refs/heads/main';
const SUPERPOWERS_REPO_LABEL = 'obra/superpowers';
const SUPERPOWERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function externalSkillsCacheDir(): string {
  return path.join(os.homedir(), '.coderblock', 'cache', 'external-skills');
}

// ---------------------------------------------------------------------------
// settings.local.json
// ---------------------------------------------------------------------------

/**
 * Ensure `<projectDir>/.claude/settings.local.json` exists and exports
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Existing keys / env entries
 * are preserved; only the agent-teams toggle is force-set.
 */
export function writeClaudeSettingsLocal(projectDir: string): void {
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON — overwrite with a known-good baseline rather
      // than crashing init.
    }
  }

  const existingEnv =
    existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
      ? (existing.env as Record<string, unknown>)
      : {};

  const merged = {
    ...existing,
    env: {
      ...existingEnv,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Bundled skills (ship inside the npm package)
// ---------------------------------------------------------------------------

/**
 * Copy every directory under `src/scaffolds/bundled-skills/` into
 * `<projectDir>/.claude/skills/<name>/` and derive matching Cursor
 * rules. Returns the list of installed skill names.
 */
export function installBundledSkills(projectDir: string): string[] {
  if (!fs.existsSync(BUNDLED_SKILLS_DIR)) return [];

  const installed: string[] = [];
  for (const entry of fs.readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const sourceDir = path.join(BUNDLED_SKILLS_DIR, entry.name);
    installLocalSkill(projectDir, entry.name, sourceDir);
    installed.push(entry.name);
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Superpowers (downloaded from GitHub at install time)
// ---------------------------------------------------------------------------

/**
 * Download (or reuse the cached copy of) `obra/superpowers@main`,
 * then copy every skill under `skills/` into the project. Returns the
 * list of installed skill names.
 *
 * Throws if the download fails AND the cache is empty/stale — callers
 * are expected to treat this as non-fatal (warn + continue), the same
 * way the Coderblock-managed skill install is treated.
 */
export async function installSuperpowersSkills(projectDir: string): Promise<string[]> {
  const repoRoot = await ensureSuperpowersCache();
  const skillsRoot = path.join(repoRoot, 'skills');

  if (!fs.existsSync(skillsRoot)) {
    throw new Error(
      `Superpowers tarball is missing the expected "skills/" directory at ${skillsRoot}.`,
    );
  }

  const installed: string[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const sourceDir = path.join(skillsRoot, entry.name);
    // A folder under skills/ only counts as a skill if it has a SKILL.md
    // at the top level (Superpowers also stores helper assets that
    // should NOT become individual skills).
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) continue;

    installLocalSkill(projectDir, entry.name, sourceDir);
    installed.push(entry.name);
  }

  return installed;
}

async function ensureSuperpowersCache(): Promise<string> {
  const cacheDir = path.join(externalSkillsCacheDir(), 'superpowers');
  const marker = path.join(cacheDir, '.ok');
  const repoRootMarker = path.join(cacheDir, '.repo-root');

  // Hit cache if fresh and we still know which dir holds the repo.
  if (fs.existsSync(marker) && fs.existsSync(repoRootMarker)) {
    const age = Date.now() - fs.statSync(marker).mtimeMs;
    const repoRoot = fs.readFileSync(repoRootMarker, 'utf8').trim();
    if (age < SUPERPOWERS_CACHE_TTL_MS && fs.existsSync(repoRoot)) {
      return repoRoot;
    }
  }

  // Stale or missing — refetch.
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const res = await request(SUPERPOWERS_TARBALL_URL, { method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `Failed to download ${SUPERPOWERS_REPO_LABEL} (HTTP ${res.statusCode} from ${SUPERPOWERS_TARBALL_URL}).`,
    );
  }

  const buf = Buffer.from(await res.body.arrayBuffer());
  const tarballPath = path.join(cacheDir, 'archive.tgz');
  fs.writeFileSync(tarballPath, buf);

  await tar.x({ file: tarballPath, cwd: cacheDir });
  fs.unlinkSync(tarballPath);

  // GitHub archives extract to `<repo>-<branch>/`; locate it dynamically
  // so we don't hard-code the branch name.
  const entries = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const repoEntry =
    entries.find((e) => e.name.startsWith('superpowers-')) ?? entries[0];
  if (!repoEntry) {
    throw new Error(
      `Superpowers tarball extracted to an unexpected layout in ${cacheDir}.`,
    );
  }

  const repoRoot = path.join(cacheDir, repoEntry.name);
  fs.writeFileSync(repoRootMarker, repoRoot);
  fs.writeFileSync(marker, new Date().toISOString());
  return repoRoot;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Copy a single skill folder into `<projectDir>/.claude/skills/<skillName>/`
 * and derive `<projectDir>/.cursor/rules/<skillName>.mdc` from its
 * `SKILL.md` (when present).
 */
export function installLocalSkill(
  projectDir: string,
  skillName: string,
  sourceDir: string,
): void {
  const claudeDest = path.join(projectDir, '.claude', 'skills', skillName);
  fs.mkdirSync(claudeDest, { recursive: true });
  copyRecursive(sourceDir, claudeDest);

  const skillMdPath = path.join(claudeDest, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    const cursorDir = path.join(projectDir, '.cursor', 'rules');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, `${skillName}.mdc`),
      skillToCursorMdc(skillMd),
    );
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
