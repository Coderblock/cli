// Shared types for the Coderblock CLI/MCP SDK.
// Mirror of the public surface documented in
// documentation/architecture/CLI_AND_MCP.md (the spec is authoritative;
// if you edit this file, keep it in sync).

export interface StoredCredentials {
  api_url: string;
  access_token: string;
  access_token_expires_at: string; // ISO 8601
  refresh_token: string;
  user: { id: string; email?: string };
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface CoderblockUser {
  id: string;
  email?: string | null;
  plan?: string | null;
  display_name?: string | null;
  min_cli_version?: string | null;
  required_cli_version?: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  has_backend: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  preview_url?: string | null;
  production_url?: string | null;
  settings: Record<string, unknown>;
}

export interface CreateProjectPayload {
  name: string;
  description?: string;
  category?: string;
  has_backend?: boolean;
  framework?: string;
  docker_image?: string | null;
}

export interface CliSession {
  id: string;
  device_name?: string | null;
  scope: string;
  created_at: string;
  last_used_at?: string | null;
  expires_at: string;
}

export interface SkillManifestEntry {
  name: string;
  version: string;
  size_bytes: number;
  always_install: boolean;
}

export interface ApiErrorBody {
  error?: { code: string; message?: string } | string;
  error_description?: string;
}

// Thrown by the SDK on any non-2xx response or transport error.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
