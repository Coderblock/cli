#!/usr/bin/env node
// Entry point for the `coderblock` binary.
// Delegates to dist/cli/main.js — kept as a thin shim so npm installs it as
// a bin wrapper but the real logic is compiled from TypeScript.
import('../dist/cli/main.js').catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
