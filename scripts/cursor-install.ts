#!/usr/bin/env node
// Instala o plugin Habblaud no Cursor (~/.cursor/plugins/local/habblaud) e grava ~/.habblaud/cursor-hook.json.
// Também pode registrar um atalho de inicialização do Windows para manter o escritório ligado.
//
//   npm run cursor:install
//   npm run cursor:uninstall
//   npm run cursor:status
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_SRC = join(ROOT, 'cursor-plugin');
const DEFAULT_PORT = 4747;

type Cmd = 'install' | 'uninstall' | 'status';

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function pluginDir(): string {
  return join(home(), '.cursor', 'plugins', 'local', 'habblaud');
}

function configPath(): string {
  return join(home(), '.habblaud', 'cursor-hook.json');
}

function startupCmdPath(): string {
  const startup = join(home(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return join(startup, 'Habblaud.cmd');
}

function parseArgs(argv: string[]): { cmd: Cmd; port: number; startup: boolean; dryRun: boolean } {
  const args = argv.slice(2);
  let cmd: Cmd = 'install';
  if (args[0] === 'uninstall' || args[0] === 'status' || args[0] === 'install') {
    cmd = args[0];
    args.shift();
  }
  let port = DEFAULT_PORT;
  let startup = process.platform === 'win32';
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--no-startup') startup = false;
    else if (a === '--startup') startup = true;
    else if (a === '--port' && args[i + 1]) {
      const n = Number.parseInt(args[++i], 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: npm run cursor:<install|uninstall|status> [-- --port N] [-- --no-startup] [-- --dry-run]`);
      process.exit(0);
    }
  }
  return { cmd, port, startup, dryRun };
}

function writeConfig(port: number, dryRun: boolean): void {
  const file = configPath();
  const body = `${JSON.stringify({ port, rootDir: ROOT, installedAt: new Date().toISOString() }, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  console.log(`Wrote ${file}`);
}

function copyPlugin(dryRun: boolean): void {
  const dest = pluginDir();
  if (!existsSync(PLUGIN_SRC)) throw new Error(`Missing plugin source: ${PLUGIN_SRC}`);
  if (dryRun) {
    console.log(`[dry-run] sync ${PLUGIN_SRC} -> ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(PLUGIN_SRC, dest, { recursive: true });
  console.log(`Installed Cursor plugin at ${dest}`);
}

function writeStartup(port: number, dryRun: boolean): void {
  if (process.platform !== 'win32') return;
  const file = startupCmdPath();
  const dist = join(ROOT, 'dist', 'server', 'index.js');
  const starter = existsSync(dist)
    ? `"${process.execPath}" "${dist}"`
    : `"${process.execPath}" "${join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')}" "${join(ROOT, 'server', 'index.ts')}"`;
  const body = `@echo off\r\nrem Habblaud auto-start (Cursor plugin)\r\nset HABBLAUD_PORT=${port}\r\nset HABBLAUD_HOST=127.0.0.1\r\ncd /d "${ROOT}"\r\nstart \"Habblaud\" /MIN ${starter}\r\n`;
  if (dryRun) {
    console.log(`[dry-run] write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  console.log(`Registered Windows startup: ${file}`);
}

function removeStartup(dryRun: boolean): void {
  if (process.platform !== 'win32') return;
  const file = startupCmdPath();
  if (!existsSync(file)) return;
  if (dryRun) {
    console.log(`[dry-run] remove ${file}`);
    return;
  }
  rmSync(file, { force: true });
  console.log(`Removed ${file}`);
}

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function status(port: number): Promise<void> {
  const dest = pluginDir();
  const cfg = configPath();
  console.log(`Plugin dir: ${dest} (${existsSync(dest) ? 'present' : 'missing'})`);
  console.log(`Config: ${cfg} (${existsSync(cfg) ? 'present' : 'missing'})`);
  if (existsSync(cfg)) {
    try {
      console.log(`Config body: ${readFileSync(cfg, 'utf8').trim()}`);
    } catch {
      // ignore
    }
  }
  if (process.platform === 'win32') {
    const s = startupCmdPath();
    console.log(`Startup: ${s} (${existsSync(s) ? 'present' : 'missing'})`);
  }
  const up = await health(port);
  console.log(`Habblaud http://127.0.0.1:${port}/api/health: ${up ? 'ok' : 'down'}`);
}

async function main(): Promise<void> {
  const { cmd, port, startup, dryRun } = parseArgs(process.argv);
  if (cmd === 'status') {
    await status(port);
    return;
  }
  if (cmd === 'uninstall') {
    const dest = pluginDir();
    if (dryRun) console.log(`[dry-run] remove ${dest}`);
    else if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`Removed ${dest}`);
    } else console.log(`Plugin already absent: ${dest}`);
    if (existsSync(configPath())) {
      if (dryRun) console.log(`[dry-run] remove ${configPath()}`);
      else {
        rmSync(configPath(), { force: true });
        console.log(`Removed ${configPath()}`);
      }
    }
    removeStartup(dryRun);
    return;
  }

  // install
  if (!existsSync(join(ROOT, 'package.json'))) throw new Error(`Habblaud root not found: ${ROOT}`);
  copyPlugin(dryRun);
  writeConfig(port, dryRun);
  if (startup) writeStartup(port, dryRun);

  const built = existsSync(join(ROOT, 'dist', 'server', 'index.js'));
  if (!built) {
    console.log('Build missing; running npm run build...');
    if (!dryRun) {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
  }

  console.log('');
  console.log('Next:');
  console.log('  1. Reload Cursor (Developer: Reload Window)');
  console.log(`  2. Open http://localhost:${port}`);
  console.log('  3. Start an agent chat; it should appear with a CURSOR badge');
  if (!(await health(port)) && !dryRun) {
    console.log('Habblaud is not running yet; starting it...');
    const dist = join(ROOT, 'dist', 'server', 'index.js');
    const child = spawn(process.execPath, [dist], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HABBLAUD_PORT: String(port), HABBLAUD_HOST: '127.0.0.1' },
      windowsHide: true,
    });
    child.unref();
    console.log(`Started Habblaud (pid ${child.pid ?? '?'})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
