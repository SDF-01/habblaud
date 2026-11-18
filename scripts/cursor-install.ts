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

function userHooksPath(): string {
  return join(home(), '.cursor', 'hooks.json');
}

const USER_HOOK_MARKER = 'habblaud-cursor-ensure';

/** Absolute command used in ~/.cursor/hooks.json so Habblaud runs in every Cursor window. */
function userHookCommand(): string {
  const script = join(pluginDir(), 'scripts', 'ensure-and-hook.mjs');
  // Windows paths with spaces need quoting inside the hooks command string.
  return `node "${script}"`;
}

const USER_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'stop',
  'subagentStart',
  'subagentStop',
  'workspaceOpen',
] as const;

function mergeUserHooks(existing: unknown, command: string): { version: number; hooks: Record<string, unknown[]> } {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (JSON.parse(JSON.stringify(existing)) as { version?: number; hooks?: Record<string, unknown[]> })
      : { version: 1, hooks: {} };
  const hooks = base.hooks && typeof base.hooks === 'object' ? base.hooks : {};
  for (const event of USER_HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const filtered = list.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const cmd = (entry as { command?: unknown }).command;
      return typeof cmd !== 'string' || (!cmd.includes(USER_HOOK_MARKER) && !cmd.includes('ensure-and-hook.mjs'));
    });
    const item: Record<string, unknown> = { command };
    if (event === 'stop' || event === 'subagentStop') item.loop_limit = 20;
    filtered.push(item);
    hooks[event] = filtered;
  }
  return { version: typeof base.version === 'number' && base.version > 0 ? base.version : 1, hooks };
}

function writeUserHooks(dryRun: boolean): void {
  const file = userHooksPath();
  const command = userHookCommand();
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    existing = undefined;
  }
  const next = mergeUserHooks(existing, command);
  if (dryRun) {
    console.log(`[dry-run] merge user hooks ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`Merged always-on user hooks at ${file}`);
}

function removeUserHooks(dryRun: boolean): void {
  const file = userHooksPath();
  if (!existsSync(file)) return;
  let existing: { version?: number; hooks?: Record<string, unknown[]> };
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; hooks?: Record<string, unknown[]> };
  } catch {
    return;
  }
  if (!existing.hooks) return;
  let changed = false;
  for (const [event, list] of Object.entries(existing.hooks)) {
    if (!Array.isArray(list)) continue;
    const next = list.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const cmd = (entry as { command?: unknown }).command;
      return typeof cmd !== 'string' || (!cmd.includes('ensure-and-hook.mjs') && !cmd.includes(USER_HOOK_MARKER));
    });
    if (next.length !== list.length) {
      changed = true;
      if (next.length) existing.hooks[event] = next;
      else delete existing.hooks[event];
    }
  }
  if (!changed) return;
  if (dryRun) {
    console.log(`[dry-run] clean user hooks ${file}`);
    return;
  }
  if (!Object.keys(existing.hooks).length) rmSync(file, { force: true });
  else writeFileSync(file, `${JSON.stringify({ version: existing.version ?? 1, hooks: existing.hooks }, null, 2)}\n`, 'utf8');
  console.log(`Cleaned Habblaud entries from ${file}`);
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
  const uh = userHooksPath();
  console.log(`User hooks: ${uh} (${existsSync(uh) ? 'present' : 'missing'})`);
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
    removeUserHooks(dryRun);
    return;
  }

  // install
  if (!existsSync(join(ROOT, 'package.json'))) throw new Error(`Habblaud root not found: ${ROOT}`);
  copyPlugin(dryRun);
  writeConfig(port, dryRun);
  writeUserHooks(dryRun);
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
