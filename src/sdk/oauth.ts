// OAuth 2.0 Device Authorization Grant client-side helper.
//
// The backend side (RFC 8628 + PKCE) is documented in
// documentation/architecture/CLI_AND_MCP.md §3. This file only handles what
// the CLI needs: generate a PKCE pair, call /oauth/device, poll /oauth/token.
//
// No keytar here — that's the credentials module's job. No file IO either.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { DEFAULT_CLIENT_ID } from './config.js';
import { ApiError, DeviceAuthResponse, TokenResponse } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePkcePair(): { verifier: string; challenge: string } {
  // 64 bytes -> 86 base64url chars (within RFC 7636 allowed range).
  const verifier = base64url(crypto.randomBytes(64)).slice(0, 96);
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return { verifier, challenge: base64url(hash) };
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent() },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.statusCode ?? 0, 'invalid_response', `Non-JSON response (${res.statusCode})`, text);
  }
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return parsed as T;
  }
  // Errors may come in two shapes:
  //  1. RFC 6749 flat:  { error: "authorization_pending", error_description: "..." }
  //  2. FastAPI wrapped: { detail: { error: "...", error_description: "..." } }
  //     or                { detail: "string" }
  //     or                { detail: [ ... ] } (pydantic validation)
  // We normalise all three so the CLI can reason about OAuth error codes.
  const raw = parsed as Record<string, any>;
  const payload =
    raw && typeof raw.detail === 'object' && raw.detail !== null && !Array.isArray(raw.detail)
      ? (raw.detail as Record<string, any>)
      : raw;
  const code =
    typeof payload.error === 'string'
      ? payload.error
      : payload.error?.code ||
        (typeof raw.detail === 'string' ? 'http_error' : undefined) ||
        'http_error';
  const msg =
    payload.error_description ||
    payload.error?.message ||
    (typeof raw.detail === 'string' ? raw.detail : undefined) ||
    `HTTP ${res.statusCode}`;
  throw new ApiError(res.statusCode ?? 0, code, msg, parsed);
}

export function userAgent(): string {
  let version = '0.0.0';
  try {
    // dist/sdk/oauth.js lives two levels deep inside the package; package.json
    // is two directories up at runtime.
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    version = parsed.version ?? version;
  } catch {
    // fallback already set
  }
  return `coderblock-cli/${version} node/${process.versions.node}`;
}

export async function startDeviceFlow(apiUrl: string, scope = 'cli:full'): Promise<{
  auth: DeviceAuthResponse;
  verifier: string;
}> {
  const { verifier, challenge } = makePkcePair();
  const auth = await postJson<DeviceAuthResponse>(`${apiUrl}/api/v1/oauth/device`, {
    client_id: DEFAULT_CLIENT_ID,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { auth, verifier };
}

export interface PollOptions {
  onTick?: (elapsed: number) => void;
  // Abort if the poll runs longer than this many seconds (safety net; the
  // backend itself enforces device_code expiry).
  maxWaitSeconds?: number;
}

/**
 * Poll /oauth/token until we get an access token, a terminal error, or the
 * max wait is reached. Honours `authorization_pending` and `slow_down` as
 * per RFC 8628 §3.5.
 */
export async function pollForToken(
  apiUrl: string,
  deviceCode: string,
  codeVerifier: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  opts: PollOptions = {},
): Promise<TokenResponse> {
  const tokenUrl = `${apiUrl}/api/v1/oauth/token`;
  const deadline = Date.now() + Math.min(expiresInSeconds, opts.maxWaitSeconds ?? 600) * 1000;
  let interval = Math.max(intervalSeconds, 1);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    opts.onTick?.(Math.floor((Date.now() - (deadline - expiresInSeconds * 1000)) / 1000));
    try {
      return await postJson<TokenResponse>(tokenUrl, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        code_verifier: codeVerifier,
        client_id: DEFAULT_CLIENT_ID,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'authorization_pending') continue;
        if (err.code === 'slow_down') {
          interval = interval * 2;
          continue;
        }
        // access_denied, expired_token, invalid_grant, etc.
        throw err;
      }
      throw err;
    }
  }
  throw new ApiError(408, 'expired_token', 'Device authorization timed out. Please retry `coderblock login`.');
}

export async function refreshAccessToken(apiUrl: string, refreshToken: string): Promise<TokenResponse> {
  return postJson<TokenResponse>(`${apiUrl}/api/v1/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export async function revokeRefreshToken(apiUrl: string, refreshToken: string): Promise<void> {
  try {
    await postJson<{ revoked: boolean }>(`${apiUrl}/api/v1/oauth/revoke`, {
      refresh_token: refreshToken,
    });
  } catch {
    // Spec: /oauth/revoke always returns 200; any transport error is
    // surfaced as a warning but not fatal for `coderblock logout`.
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
