#!/usr/bin/env node
// Prepares the Tauri desktop shell: ensures Habblaud is built and copies dist/ into
// desktop/src-tauri/resources/habblaud for packaging inside the .exe bundle.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'desktop', 'src-tauri', 'resources', 'habblaud');
const mode = process.argv.includes('--dev') ? 'dev' : 'build';

function hasBuild() {
  return (
    existsSync(join(ROOT, 'dist', 'server', 'index.js')) &&
    existsSync(join(ROOT, 'dist', 'client', 'index.html'))
  );
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!hasBuild()) {
  console.log('[desktop-prepare] building Habblaud (client + server)…');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
}

if (mode === 'build') {
  console.log(`[desktop-prepare] syncing dist -> ${DEST}`);
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  cpSync(join(ROOT, 'dist'), join(DEST, 'dist'), { recursive: true });
  // package.json is used by the server for version/repo metadata.
  cpSync(join(ROOT, 'package.json'), join(DEST, 'package.json'));
}

console.log(`[desktop-prepare] ready (${mode})`);
