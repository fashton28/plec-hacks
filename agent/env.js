/**
 * Tiny .env reader shared by every entry point: KEY=value lines, # comments,
 * optional quotes. Never overrides a real env var.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

/** Set KEY=value in a .env file, replacing the line if the key is already there. For values the app obtains itself, like an OAuth refresh token. */
export function saveDotEnvValue(path, key, value) {
  const line = `${key}="${String(value).replace(/["\\\n]/g, '')}"`;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = pattern.test(text) ? text.replace(pattern, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
}
