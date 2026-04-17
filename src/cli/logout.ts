// `coderblock logout` — revoke refresh token server-side and wipe local state.

import { readConfig } from '../sdk/config.js';
import { deleteCredentials, loadCredentials } from '../sdk/credentials.js';
import { revokeRefreshToken } from '../sdk/oauth.js';
import { log } from './common.js';

export async function logoutCommand(): Promise<void> {
  const cfg = readConfig();
  const creds = await loadCredentials();
  if (!creds) {
    log.dim('Not logged in.');
    return;
  }
  try {
    await revokeRefreshToken(cfg.api_url, creds.refresh_token);
  } catch {
    // best-effort — the CLI still needs to clear the local file
  }
  await deleteCredentials();
  log.ok('Logged out. Local credentials removed.');
}
