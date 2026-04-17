// Shared helpers for CLI commands — colors, error formatting, printing tables.
// Keep this file thin; anything with business logic belongs in sdk/.

import pc from 'picocolors';
import { ApiError } from '../sdk/types.js';

export const log = {
  ok: (msg: string) => console.log(`${pc.green('✓')} ${msg}`),
  info: (msg: string) => console.log(msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  warn: (msg: string) => console.log(`${pc.yellow('!')} ${msg}`),
  err: (msg: string) => console.error(`${pc.red('✗')} ${msg}`),
  kv: (k: string, v: string) => console.log(`  ${pc.dim(k.padEnd(12))} ${v}`),
};

export function renderError(err: unknown): void {
  if (err instanceof ApiError) {
    log.err(`${err.message}${err.code ? pc.dim(` [${err.code}]`) : ''}`);
    if (err.status === 401 || err.code === 'not_logged_in' || err.code === 'session_expired') {
      log.dim('Run `coderblock login` to (re)authenticate.');
    }
    return;
  }
  if (err instanceof Error) {
    log.err(err.message);
    return;
  }
  log.err(String(err));
}

export function fatal(err: unknown, exitCode = 1): never {
  renderError(err);
  process.exit(exitCode);
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function renderTable(rows: Record<string, string>[], columns: string[]): void {
  if (rows.length === 0) {
    log.dim('(no results)');
    return;
  }
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length));
  }
  const header = columns.map((c) => pc.bold(c.padEnd(widths[c]))).join('  ');
  console.log(header);
  console.log(columns.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const r of rows) {
    console.log(columns.map((c) => (r[c] ?? '').padEnd(widths[c])).join('  '));
  }
}
