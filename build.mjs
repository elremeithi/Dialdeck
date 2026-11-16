#!/usr/bin/env node
// Builds browser-specific packages from ./extension into ./dist (no dependencies needed).
//   node build.mjs            -> dist/chrome, dist/firefox + zip files
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const src = join(root, 'extension');
const dist = join(root, 'dist');
const base = JSON.parse(readFileSync(join(src, 'manifest.base.json'), 'utf8'));

const targets = {
  chrome: m => ({
    ...m,
    permissions: [...m.permissions, 'favicon'],
    background: { service_worker: 'background.js', type: 'module' },
    minimum_chrome_version: '116',
  }),
  firefox: m => ({
    ...m,
    background: { page: 'background.html' },
    browser_specific_settings: { gecko: { id: 'dialdeck@selfhosted', strict_min_version: '128.0' } },
    options_ui: { page: 'options.html', open_in_tab: true },
  }),
};

rmSync(dist, { recursive: true, force: true });
for (const [name, fn] of Object.entries(targets)) {
  const out = join(dist, name);
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true, filter: p => !p.endsWith('manifest.base.json') && !(name === 'chrome' && p.endsWith('background.html')) });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(fn(structuredClone(base)), null, 2));
  try {
    execSync(`cd "${out}" && zip -qr "../dialdeck-${name}-${base.version}.${name === 'firefox' ? 'xpi' : 'zip'}" .`);
  } catch { console.warn('zip not available; skipped archive for', name); }
  console.log('built', name);
}
if (!existsSync(join(src, 'icons', 'icon-128.png'))) console.warn('icons missing: run python3 tools/make-icons.py extension/icons');
