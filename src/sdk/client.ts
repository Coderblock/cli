// High-level HTTP client for the `/api/v1/cli/*` surface.
//
// Responsibilities:
//   - Bearer auth on every request using stored credentials.
//   - Silent access-token refresh using the refresh token when we see 401.
//   - JSON in / JSON out for regular endpoints, raw streaming for /files.
//
// This module is the only place in the SDK that touches both credentials
// and the network — keeps the rest of the codebase pure.

import { request, Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import { loadCredentials, saveCredentials } from './credentials.js';
import { refreshAccessToken, userAgent } from './oauth.js';
import {
  ApiError,
  CliSession,
  CoderblockUser,
  CreateProjectPayload,
  ProjectDetail,
  ProjectSummary,
  SkillManifestEntry,
  StoredCredentials,
  TokenResponse,
} from './types.js';

export class CoderblockClient {
  constructor(private readonly apiUrl: string) {}

  /** Build a request with Bearer token + UA + retry-on-401. */
  private async authed(
    method: Dispatcher.HttpMethod,
    path: string,
    opts: { body?: Buffer | string; contentType?: string; responseType?: 'json' | 'buffer' | 'stream'; extraHeaders?: Record<string, string> } = {},
  ): Promise<any> {
    const creds = await loadCredentials();
    if (!creds) {
      throw new ApiError(401, 'not_logged_in', 'Not logged in. Run `coderblock login` first.');
    }
    let token = creds.access_token;

    // Refresh proactively if the access token is within 60s of expiry.
    const expMs = new Date(creds.access_token_expires_at).getTime();
    if (!Number.isNaN(expMs) && expMs - Date.now() < 60_000) {
      token = await this.rotateToken(creds);
    }

    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'user-agent': userAgent(),
      ...opts.extraHeaders,
    };
    if (opts.contentType) headers['content-type'] = opts.contentType;
    else if (opts.body && !Buffer.isBuffer(opts.body)) headers['content-type'] = 'application/json';

    let res = await request(url, { method, headers, body: opts.body });

    // Auto-refresh on 401 and retry once.
    if (res.statusCode === 401) {
      token = await this.rotateToken(creds);
      headers.authorization = `Bearer ${token}`;
      res = await request(url, { method, headers, body: opts.body });
    }

    return await this.handleResponse(res, opts.responseType ?? 'json');
  }

  private async handleResponse(
    res: Dispatcher.ResponseData,
    responseType: 'json' | 'buffer' | 'stream',
  ) {
    const ok = res.statusCode >= 200 && res.statusCode < 300;

    if (responseType === 'stream' && ok) {
      return { body: res.body, headers: res.headers, statusCode: res.statusCode };
    }
    if (responseType === 'buffer' && ok) {
      const buf = Buffer.from(await res.body.arrayBuffer());
      return { body: buf, headers: res.headers, statusCode: res.statusCode };
    }

    const text = await res.body.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      if (!ok) {
        throw new ApiError(res.statusCode ?? 0, 'invalid_response', `Unexpected response (HTTP ${res.statusCode})`, text);
      }
      return text;
    }
    if (ok) return parsed;

    const code = parsed?.error?.code || (typeof parsed?.error === 'string' ? parsed.error : 'http_error');
    const msg = parsed?.error?.message || parsed?.error_description || parsed?.detail?.error?.message || `HTTP ${res.statusCode}`;
    throw new ApiError(res.statusCode ?? 0, code, msg, parsed);
  }

  /** Exchange refresh token for a new access token + rotate. */
  private async rotateToken(creds: StoredCredentials): Promise<string> {
    let tok: TokenResponse;
    try {
      tok = await refreshAccessToken(this.apiUrl, creds.refresh_token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        throw new ApiError(401, 'session_expired', 'Your CLI session has expired. Run `coderblock login` again.');
      }
      throw err;
    }
    const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
    const next: StoredCredentials = {
      ...creds,
      access_token: tok.access_token,
      access_token_expires_at: expiresAt,
      refresh_token: tok.refresh_token,
    };
    await saveCredentials(next);
    return tok.access_token;
  }

  // -------------------------------------------------------------------------
  // User
  // -------------------------------------------------------------------------

  user(): Promise<CoderblockUser> {
    return this.authed('GET', '/api/v1/cli/user');
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(params: { limit?: number; offset?: number } = {}): Promise<{
    projects: ProjectSummary[];
    count: number;
    limit: number;
    offset: number;
  }> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.authed('GET', `/api/v1/cli/projects${suffix}`);
  }

  createProject(body: CreateProjectPayload): Promise<ProjectDetail> {
    return this.authed('POST', '/api/v1/cli/projects', { body: JSON.stringify(body) });
  }

  getProject(id: string): Promise<ProjectDetail> {
    return this.authed('GET', `/api/v1/cli/projects/${id}`);
  }

  async uploadTarball(id: string, tarball: Buffer): Promise<{ uploaded_files: number; bytes: number }> {
    return this.authed('PUT', `/api/v1/cli/projects/${id}/files`, {
      body: tarball,
      contentType: 'application/gzip',
    });
  }

  async downloadTarball(id: string): Promise<{ body: Readable; headers: Record<string, any> }> {
    const res = await this.authed('GET', `/api/v1/cli/projects/${id}/files`, { responseType: 'stream' });
    return { body: res.body as unknown as Readable, headers: res.headers as Record<string, any> };
  }

  async downloadTarballBuffer(id: string): Promise<{ buffer: Buffer; headers: Record<string, any> }> {
    const res = await this.authed('GET', `/api/v1/cli/projects/${id}/files`, { responseType: 'buffer' });
    return { buffer: res.body as Buffer, headers: res.headers as Record<string, any> };
  }

  triggerPreview(id: string): Promise<{ triggered: boolean; preview_url: string }> {
    return this.authed('POST', `/api/v1/cli/projects/${id}/preview`, { body: '{}' });
  }

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  listSkills(params: { category?: string; frontend_only?: boolean } = {}): Promise<{ skills: SkillManifestEntry[] }> {
    const qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.frontend_only != null) qs.set('frontend_only', String(params.frontend_only));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.authed('GET', `/api/v1/cli/skills${suffix}`);
  }

  async downloadSkill(name: string, version: string): Promise<Buffer> {
    const res = await this.authed('GET', `/api/v1/cli/skills/${name}/${version}/archive`, { responseType: 'buffer' });
    return res.body as Buffer;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(): Promise<{ sessions: CliSession[]; count: number }> {
    return this.authed('GET', '/api/v1/cli/sessions');
  }

  revokeSession(sessionId: string): Promise<{ revoked: boolean }> {
    return this.authed('DELETE', `/api/v1/cli/sessions/${sessionId}`);
  }
}
