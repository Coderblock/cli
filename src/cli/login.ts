// `coderblock login` — OAuth 2.0 Device Authorization Grant (RFC 8628 + PKCE).
//
// 1. POST /oauth/device to get a device_code + user_code.
// 2. Open the browser to the verification URL (and print it as fallback).
// 3. Poll /oauth/token every `interval` seconds.
// 4. On success, write credentials to ~/.coderblock and confirm the user.

import open from 'open';
import pc from 'picocolors';
import { readConfig } from '../sdk/config.js';
import { saveCredentials } from '../sdk/credentials.js';
import { pollForToken, startDeviceFlow } from '../sdk/oauth.js';
import { CoderblockClient } from '../sdk/client.js';
import { StoredCredentials } from '../sdk/types.js';
import { fatal, log } from './common.js';

export async function loginCommand(opts: { noBrowser?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  log.dim(`Using API: ${cfg.api_url}`);

  let auth, verifier;
  try {
    ({ auth, verifier } = await startDeviceFlow(cfg.api_url));
  } catch (err) {
    fatal(err);
  }

  console.log();
  console.log(`Open this URL in your browser to authorize the CLI:`);
  console.log(pc.cyan(`  ${auth.verification_uri_complete}`));
  console.log();
  console.log(`If your browser asks you to confirm a code, it's:`);
  console.log(`  ${pc.bold(auth.user_code)}`);
  console.log();

  if (!opts.noBrowser) {
    try {
      await open(auth.verification_uri_complete);
    } catch {
      // opening the browser is optional — the URL is printed above.
    }
  }

  log.dim(`Waiting for authorization (expires in ${Math.round(auth.expires_in / 60)} min)…`);

  let token;
  try {
    token = await pollForToken(
      cfg.api_url,
      auth.device_code,
      verifier,
      auth.interval,
      auth.expires_in,
    );
  } catch (err) {
    fatal(err);
  }

  // We have tokens; fetch the user so we can save email for keychain/UI.
  const creds: StoredCredentials = {
    api_url: cfg.api_url,
    access_token: token.access_token,
    access_token_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    refresh_token: token.refresh_token,
    user: { id: '' },
  };
  // Persist minimal creds so the client can authenticate the /cli/user call.
  await saveCredentials(creds);

  try {
    const client = new CoderblockClient(cfg.api_url);
    const me = await client.user();
    await saveCredentials({
      ...creds,
      user: { id: me.id, email: me.email ?? undefined },
    });
    log.ok(`Logged in as ${pc.bold(me.email ?? me.id)}`);
  } catch (err) {
    log.warn('Logged in, but could not fetch user profile right now.');
    log.dim('You can try `coderblock status` to verify the session.');
  }
}
