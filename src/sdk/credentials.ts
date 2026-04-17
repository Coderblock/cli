// Secure credential storage for the Coderblock CLI.
//
// We write `~/.coderblock/credentials` as a chmod 600 JSON file. If `keytar`
// is installed (optional dependency, installs without native compilation on
// most platforms), the *refresh token* is additionally stored in the OS
// keychain. This gives us a best-effort defence-in-depth: even a JSON-read
// attack on the file would get a short-lived access token at worst.
//
// The CLI must never crash because keytar is missing — it's an enhancement,
// not a requirement. Hence all keytar calls are wrapped in try/catch and
// treated as optional.

import fs from 'node:fs';
import { credentialsPath, configDir } from './config.js';
import { StoredCredentials } from './types.js';

const KEYTAR_SERVICE = 'coderblock-cli';

async function tryKeytar(): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import('keytar');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });

  // Write the full JSON first — the access token lives here either way.
  // Refresh token is also stored here as a fallback if keytar isn't usable.
  const disk: StoredCredentials = { ...creds };
  fs.writeFileSync(credentialsPath(), JSON.stringify(disk, null, 2), { mode: 0o600 });

  // Best-effort mirror refresh_token to keychain.
  const keytar = await tryKeytar();
  if (keytar && creds.user?.email) {
    try {
      await keytar.setPassword(KEYTAR_SERVICE, creds.user.email, creds.refresh_token);
    } catch {
      // keychain not unlocked, unsupported OS, etc. — silently fall back.
    }
  }
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  let disk: StoredCredentials | null = null;
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    disk = JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
  if (!disk) return null;

  // Prefer keychain value if present — makes rotating the refresh token easier.
  const keytar = await tryKeytar();
  if (keytar && disk.user?.email) {
    try {
      const kc = await keytar.getPassword(KEYTAR_SERVICE, disk.user.email);
      if (kc) {
        disk.refresh_token = kc;
      }
    } catch {
      // ignore
    }
  }
  return disk;
}

export async function deleteCredentials(): Promise<void> {
  let email: string | undefined;
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredCredentials;
    email = parsed.user?.email;
  } catch {
    // no disk file — still try keychain below for safety.
  }

  try {
    fs.unlinkSync(credentialsPath());
  } catch {
    // not there — ok.
  }

  const keytar = await tryKeytar();
  if (keytar && email) {
    try {
      await keytar.deletePassword(KEYTAR_SERVICE, email);
    } catch {
      // ignore
    }
  }
}
