// Resolves the active configuration for the CLI/SDK.
//
// Precedence (highest first):
//   1. Explicit argument passed in code
//   2. Environment variable (CODERBLOCK_API_URL)
//   3. ~/.coderblock/config.json
//   4. Hard-coded default (production API)
//
// Keep this tiny — loading config should never block or throw; callers
// handle missing/invalid files gracefully.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://api.coderblock.ai';
export const DEFAULT_CLIENT_ID = 'coderblock-cli';

export interface CliConfig {
  api_url: string;
  telemetry: boolean;
  default_category?: string;
}

export function configDir(): string {
  return path.join(os.homedir(), '.coderblock');
}

export function credentialsPath(): string {
  return path.join(configDir(), 'credentials');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function skillsCacheDir(): string {
  return path.join(configDir(), 'skills-cache');
}

export function readConfig(): CliConfig {
  let fileCfg: Partial<CliConfig> = {};
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    fileCfg = JSON.parse(raw);
  } catch {
    // missing or malformed — ignore
  }
  const envUrl = process.env.CODERBLOCK_API_URL;
  return {
    api_url: envUrl || fileCfg.api_url || DEFAULT_API_URL,
    telemetry: fileCfg.telemetry ?? true,
    default_category: fileCfg.default_category,
  };
}

export function writeConfig(cfg: Partial<CliConfig>): void {
  const current = readConfig();
  const merged = { ...current, ...cfg };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
}
