// Minimal interactive prompts used by `coderblock init`. We intentionally
// implement this on top of Node's built-in readline/promises instead of
// pulling a third-party dependency (inquirer, prompts, enquirer) — the
// feature set we need is small (one-line text, single-select, confirm)
// and every extra dep in a CLI is a supply-chain surface we'd rather not
// own.
//
// All helpers are TTY-aware: in non-interactive contexts (CI, piped
// stdin, `--no-interactive`) they raise so the caller can fall back to
// defaults. The caller is responsible for calling `isInteractive()`
// first and skipping prompts accordingly.

import readline from 'node:readline/promises';
import pc from 'picocolors';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface TextPromptOptions {
  default?: string;
  required?: boolean;
  /** Validator returning `true` or an error message. */
  validate?: (value: string) => true | string;
}

/**
 * Ask for a free-form string. Re-prompts if `required` and empty, or if
 * `validate` returns an error message.
 */
export async function promptText(
  question: string,
  opts: TextPromptOptions = {},
): Promise<string> {
  if (!isInteractive()) {
    throw new Error('promptText requires a TTY');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint = opts.default ? pc.dim(` (${opts.default})`) : '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = (await rl.question(`${pc.cyan('?')} ${question}${hint} `)).trim();
      const value = raw || opts.default || '';
      if (!value && opts.required) {
        console.log(pc.yellow('  This answer is required.'));
        continue;
      }
      if (opts.validate) {
        const ok = opts.validate(value);
        if (ok !== true) {
          console.log(pc.yellow(`  ${ok}`));
          continue;
        }
      }
      return value;
    }
  } finally {
    rl.close();
  }
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Display a numbered list and ask for a 1-based index. Accepts the raw
 * `value` as shortcut (e.g. typing `gaming` instead of `8`). Loops until
 * a valid answer is given.
 */
export async function promptSelect<T extends string>(
  question: string,
  choices: SelectChoice<T>[],
  opts: { default?: T } = {},
): Promise<T> {
  if (!isInteractive()) {
    throw new Error('promptSelect requires a TTY');
  }
  if (choices.length === 0) throw new Error('promptSelect: choices is empty');

  const defaultIdx = opts.default
    ? choices.findIndex((c) => c.value === opts.default)
    : -1;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(`${pc.cyan('?')} ${question}`);
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const isDefault = i === defaultIdx;
      const marker = isDefault ? pc.cyan('›') : ' ';
      const label = isDefault ? pc.bold(c.label) : c.label;
      const hint = c.hint ? pc.dim(`  — ${c.hint}`) : '';
      console.log(`  ${marker} ${String(i + 1).padStart(2)}. ${label}${hint}`);
    }
    const fallbackHint =
      defaultIdx >= 0 ? pc.dim(` (${defaultIdx + 1})`) : '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = (
        await rl.question(`${pc.cyan('>')} Pick one${fallbackHint}: `)
      ).trim();

      if (!raw && defaultIdx >= 0) return choices[defaultIdx].value;

      // Accept number
      const asNum = Number.parseInt(raw, 10);
      if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= choices.length) {
        return choices[asNum - 1].value;
      }
      // Accept the literal value
      const byValue = choices.find(
        (c) => c.value.toLowerCase() === raw.toLowerCase(),
      );
      if (byValue) return byValue.value;

      console.log(
        pc.yellow(`  Enter a number between 1 and ${choices.length}.`),
      );
    }
  } finally {
    rl.close();
  }
}

export async function promptConfirm(
  question: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  if (!isInteractive()) {
    throw new Error('promptConfirm requires a TTY');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint =
      opts.default === undefined
        ? pc.dim(' (y/n)')
        : opts.default
          ? pc.dim(' (Y/n)')
          : pc.dim(' (y/N)');

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = (await rl.question(`${pc.cyan('?')} ${question}${hint} `))
        .trim()
        .toLowerCase();
      if (!raw && opts.default !== undefined) return opts.default;
      if (raw === 'y' || raw === 'yes') return true;
      if (raw === 'n' || raw === 'no') return false;
      console.log(pc.yellow('  Please answer "y" or "n".'));
    }
  } finally {
    rl.close();
  }
}
