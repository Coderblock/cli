// Supabase webapp scaffold for `coderblock init --runtime supabase` (and
// `reshape --runtime supabase`).
//
// A supabase project is a **pure React frontend + Supabase backend** (Auth,
// Postgres + RLS, Storage, Edge Functions). There is NO server process and NO
// ORM: the "backend" is the declarative `backend/supabase/` folder (SQL
// migrations + Deno Edge Functions). This mirrors the platform template at
// `backend/templates/backend-supabase/` — keep the two in sync when the
// canonical baseline changes.
//
// The CLI is a self-contained npm package, so the template content is inlined
// here as string literals rather than fetched from the server.

import fs from 'node:fs';
import path from 'node:path';

// -----------------------------------------------------------------------------
// File contents (faithful copies of backend/templates/backend-supabase/)
// -----------------------------------------------------------------------------

const CONFIG_TOML = `# Supabase project config (Coderblock supabase webapp runtime).
# The \`project_id\` is the Supabase project ref; Coderblock fills it in at
# provisioning time (it equals the ref in supabase_project_mappings).
project_id = "REPLACE_WITH_PROJECT_REF"

[functions.health]
# Public health probe — no JWT required.
verify_jwt = false

[functions.ai-chat]
# Authenticated AI chat proxy → Coderblock AI Gateway. Requires a logged-in
# user (supabase-js attaches the access token automatically on invoke()).
verify_jwt = true

# Convention for generated functions:
#   * User-data / privileged actions  -> verify_jwt = true  (default)
#   * Public webhooks (e.g. Stripe)   -> verify_jwt = false + verify signature
# Declare each new function here, e.g.:
# [functions.create-checkout]
# verify_jwt = true
`;

const INIT_MIGRATION = `-- ════════════════════════════════════════════════════════════════════════
-- Coderblock Supabase webapp — baseline migration
-- ════════════════════════════════════════════════════════════════════════
-- Canonical SAFE auth pattern (mirrors the validated Lovable baseline):
--   * Roles live in a SEPARATE \`user_roles\` table — NEVER as a column on a
--     profile row (prevents privilege-escalation via row updates).
--   * Role checks go through a SECURITY DEFINER function \`has_role()\` so RLS
--     policies can call it without recursive RLS evaluation.
--   * Every table has RLS enabled and policies keyed to \`auth.uid()\`.
--   * \`update_updated_at_column()\` keeps \`updated_at\` fresh via triggers.
-- Agents MUST follow this pattern for every new table (see the
-- supabase-database / add-authentication-supabase skills).
-- ════════════════════════════════════════════════════════════════════════

-- ── Roles ────────────────────────────────────────────────────────────────
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER so policies can call it without triggering RLS recursion.
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- A user can read their own roles; only admins manage roles.
CREATE POLICY "view own roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "admins manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ── updated_at trigger helper ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── Profiles (example domain table following the safe pattern) ────────────
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles are viewable by owner"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users insert own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

CREATE POLICY "users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── New-user bootstrap: create a profile + default role on signup ─────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'display_name')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
`;

const CORS_TS = `// Shared CORS helpers for Supabase Edge Functions (Deno).
// Import in every function: \`import { corsHeaders, handleCors } from "../_shared/cors.ts";\`

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

/** Return a 204 preflight response when the request is an OPTIONS preflight. */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

/** Wrap a JSON payload with CORS headers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
`;

const HEALTH_FN = `// Public health probe Edge Function (Deno).
// verify_jwt = false (see config.toml). Returns service status + timestamp.
//
// This is the canonical shape for an Edge Function:
//   1. Handle CORS preflight first.
//   2. Do the work.
//   3. Return JSON with CORS headers.
import { handleCors, jsonResponse } from "../_shared/cors.ts";

Deno.serve((req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  return jsonResponse({
    status: "ok",
    service: "edge-functions",
    timestamp: new Date().toISOString(),
  });
});
`;

const AI_CHAT_FN = `// ai-chat — canonical AI chat Edge Function (Deno).
//
// This is the ONE common AI pattern shared across Coderblock supabase apps
// (validated against the Lovable \`swapple\` pattern). The frontend NEVER calls a
// model provider directly and NEVER embeds a model SDK. Instead it calls this
// function via \`supabase.functions.invoke("ai-chat", ...)\`, and this function
// proxies to the **Coderblock AI Gateway** (OpenAI-compatible, one injected key,
// metered server-side).
//
// Flow:  authenticate caller (getUser) → forward to gateway → stream/JSON back.
//
// Env (injected by Coderblock as Edge Function secrets):
//   * CODERBLOCK_AI_BASE — gateway base URL (OpenAI-compatible)
//   * CODERBLOCK_AI_KEY  — per-project gateway key
//   * SUPABASE_URL / SUPABASE_ANON_KEY — auto-injected by Supabase
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCors, jsonResponse } from "../_shared/cors.ts";

const GATEWAY_BASE = Deno.env.get("CODERBLOCK_AI_BASE") ?? "";
const GATEWAY_KEY = Deno.env.get("CODERBLOCK_AI_KEY") ?? "";
const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  try {
    if (!GATEWAY_BASE || !GATEWAY_KEY) {
      return jsonResponse({ error: "AI gateway not configured" }, 503);
    }

    // Authenticate the caller (config.toml sets verify_jwt=true, but we also
    // resolve the user here for per-user logic / metering).
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const { messages, model, stream = false } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: "messages[] is required" }, 400);
    }

    const upstream = await fetch(\`\${GATEWAY_BASE}/v1/chat/completions\`, {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${GATEWAY_KEY}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, messages, stream }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("AI gateway error:", upstream.status, errText);
      if (upstream.status === 429) return jsonResponse({ error: "Rate limit exceeded" }, 429);
      if (upstream.status === 402) return jsonResponse({ error: "AI credits exhausted" }, 402);
      return jsonResponse({ error: "AI gateway error" }, 502);
    }

    // Streaming: pass the SSE body straight through to the browser.
    if (stream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const data = await upstream.json();
    return jsonResponse(data, 200);
  } catch (e) {
    console.error("ai-chat error:", e);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
`;

const CLIENT_TS = `// Supabase client — single source for all frontend data/auth/storage calls.
// Import as: \`import { supabase } from "@/integrations/supabase/client";\`
//
// The URL + anon key are PUBLIC and injected at build/preview time by
// Coderblock as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. NEVER put the
// service_role key in the frontend — privileged operations belong in Edge
// Functions.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || "";
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || "";

/** True once the backend is provisioned and env is injected. Gate auth/data UI on this. */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!isSupabaseConfigured) {
  // Right after project creation the Supabase project is still provisioning, so
  // the env vars may be empty for a few seconds. Warn — but DON'T pass empty
  // strings to createClient(): supabase-js throws "supabaseUrl is required" at
  // import time, white-screening the WHOLE app. Reload once provisioning ends.
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set yet — " +
      "backend still provisioning or env injection pending. Reload in a few seconds.",
  );
}

export const supabase = createClient<Database>(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY || "placeholder-anon-key",
  {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
`;

const AI_TS = `// AI chat client — talks to the \`ai-chat\` Edge Function, which proxies to the
// Coderblock AI Gateway. NEVER call a model provider or embed a model SDK in the
// frontend; always go through this helper.
//
// Usage:
//   const reply = await sendChat([{ role: "user", content: "Hi" }]);
//   for await (const token of streamChat(messages)) setText((t) => t + token);
import { supabase } from "./client";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Non-streaming chat. Returns the assistant message text. */
export async function sendChat(
  messages: ChatMessage[],
  model?: string,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("ai-chat", {
    body: { messages, model, stream: false },
  });
  if (error) throw error;
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Streaming chat. Yields text deltas as they arrive (OpenAI-style SSE). */
export async function* streamChat(
  messages: ChatMessage[],
  model?: string,
): AsyncGenerator<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const url = \`\${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat\`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      ...(token ? { Authorization: \`Bearer \${token}\` } : {}),
    },
    body: JSON.stringify({ messages, model, stream: true }),
  });

  if (!resp.ok || !resp.body) {
    throw new Error(\`ai-chat failed: \${resp.status}\`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    }
  }
}
`;

const TYPES_TS = `// Generated database types placeholder.
//
// Regenerate from the live schema after editing migrations, e.g.:
//   supabase gen types typescript --project-id <ref> > src/integrations/supabase/types.ts
//
// Until regenerated this permissive shape keeps the client typed without
// blocking development. The baseline migration ships \`user_roles\` + \`profiles\`.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      [key: string]: {
        Row: Record<string, Json>;
        Insert: Record<string, Json>;
        Update: Record<string, Json>;
      };
    };
    Views: { [key: string]: { Row: Record<string, Json> } };
    Functions: {
      has_role: {
        Args: { _user_id: string; _role: "admin" | "user" };
        Returns: boolean;
      };
    };
    Enums: {
      app_role: "admin" | "user";
    };
  };
}
`;

const FRONTEND_ENV_EXAMPLE = `# ──────────────────────────────────────────────────────────────────────
# Coderblock supabase webapp — frontend environment
# ──────────────────────────────────────────────────────────────────────
# Copy to .env.local for local dev. In preview/production these are injected
# automatically by Coderblock from the project's provisioned Supabase backend.
# Both values are PUBLIC and safe to ship in the bundle.

VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# NOTE: There is no backend server and no DATABASE_URL. The frontend talks
# directly to Supabase (Auth/DB/Storage) and to Edge Functions via
# \`supabase.functions.invoke(...)\`. The service_role key is NEVER exposed here.
`;

// -----------------------------------------------------------------------------
// Scaffold writer
// -----------------------------------------------------------------------------

/**
 * Write the declarative supabase backend (`backend/supabase/`) plus the
 * frontend Supabase integration (`frontend/src/integrations/supabase/*` +
 * `frontend/.env.example`) into `projectDir`.
 *
 * Mirrors `backend/templates/backend-supabase/` — there is NO FastAPI backend,
 * no `.env` with a SECRET_KEY, and no DATABASE_URL.
 */
export function scaffoldSupabaseBackend(projectDir: string): void {
  const sb = path.join(projectDir, 'backend', 'supabase');
  const migrations = path.join(sb, 'migrations');
  const sharedFns = path.join(sb, 'functions', '_shared');
  const healthFn = path.join(sb, 'functions', 'health');
  const aiChatFn = path.join(sb, 'functions', 'ai-chat');
  for (const d of [migrations, sharedFns, healthFn, aiChatFn]) {
    fs.mkdirSync(d, { recursive: true });
  }

  fs.writeFileSync(path.join(sb, 'config.toml'), CONFIG_TOML);
  fs.writeFileSync(path.join(migrations, '0000_init.sql'), INIT_MIGRATION);
  fs.writeFileSync(path.join(sharedFns, 'cors.ts'), CORS_TS);
  fs.writeFileSync(path.join(healthFn, 'index.ts'), HEALTH_FN);
  fs.writeFileSync(path.join(aiChatFn, 'index.ts'), AI_CHAT_FN);
}

/**
 * Write the frontend Supabase integration files. Safe to call for both
 * fullstack and frontend-only supabase projects (the frontend always talks to
 * Supabase directly).
 */
export function scaffoldSupabaseFrontend(projectDir: string): void {
  const integrations = path.join(projectDir, 'frontend', 'src', 'integrations', 'supabase');
  fs.mkdirSync(integrations, { recursive: true });
  fs.writeFileSync(path.join(integrations, 'client.ts'), CLIENT_TS);
  fs.writeFileSync(path.join(integrations, 'ai.ts'), AI_TS);
  fs.writeFileSync(path.join(integrations, 'types.ts'), TYPES_TS);
  fs.writeFileSync(path.join(projectDir, 'frontend', '.env.example'), FRONTEND_ENV_EXAMPLE);
  // The integration files above import `@supabase/supabase-js`, so the frontend
  // manifest MUST declare it or Vite fails to resolve the import. Patch it
  // deterministically when a package.json already exists (e.g. `reshape` on an
  // existing project). On `init`, the base manifest is generated afterwards from
  // the prompt — which already lists @supabase/supabase-js — so we only top it
  // up here when the file is present. Mirrors the platform's dedicated
  // `react-vite-ts-supabase` template.
  ensureSupabaseJsDependency(path.join(projectDir, 'frontend', 'package.json'));
}

/** Declare `@supabase/supabase-js` in a frontend package.json if missing. No-op
 * when the file is absent or unparseable (best-effort). */
function ensureSupabaseJsDependency(pkgPath: string): void {
  if (!fs.existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies['@supabase/supabase-js']) {
      pkg.dependencies['@supabase/supabase-js'] = '^2.53.0';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  } catch {
    // Leave the manifest untouched if it can't be read/parsed.
  }
}
