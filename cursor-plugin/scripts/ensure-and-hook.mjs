#!/usr/bin/env node
// Habblaud Cursor hook: keep the office server running and forward agent events.
// Fail-open: never block the Cursor agent. Speaks only to 127.0.0.1.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4747;
const CONFIG_FILE = 'cursor-hook.json';
const EVENT_TIMEOUT_MS = 1_500;
const ENSURE_TIMEOUT_MS = 8_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 2 * 1024 * 1024;
const MAX_STRING = 8_000;

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-cursor] ${msg}\n`) : () => {};

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validPort(p) {
  return Number.isInteger(p) && p > 0 && p < 65_536;
}

function homeOf(env = process.env) {
  return env.HOME || env.USERPROFILE || homedir();
}

function readConfig(env = process.env) {
  const home = homeOf(env);
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const rootDir = typeof f.rootDir === 'string' && f.rootDir.trim() ? resolve(f.rootDir.trim()) : undefined;
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    rootDir,
  };
}

function clip(v) {
  if (typeof v !== 'string') return v;
  return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING - 1)}…` : v;
}

function clipDeep(v, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof v === 'string') return clip(v);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => clipDeep(x, depth + 1));
  if (isObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, 40)) out[k] = clipDeep(val, depth + 1);
    return out;
  }
  return v;
}

async function readStdin() {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), STDIN_TIMEOUT_MS);
    const finish = (text) => {
      clearTimeout(timer);
      resolvePromise(text);
    };
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

async function fetchJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, json: undefined };
    }
  } finally {
    clearTimeout(t);
  }
}

async function health(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function startDetached(rootDir, port) {
  if (!rootDir || !existsSync(rootDir)) {
    debug(`no rootDir to start Habblaud (got ${rootDir ?? 'undefined'})`);
    return false;
  }
  const dist = join(rootDir, 'dist', 'server', 'index.js');
  const entry = existsSync(dist) ? dist : join(rootDir, 'server', 'index.ts');
  const useTsx = entry.endsWith('.ts');
  const cmd = useTsx ? process.execPath : process.execPath;
  const args = useTsx
    ? [join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry]
    : [entry];
  if (useTsx && !existsSync(args[0])) {
    debug('tsx missing; run npm install && npm run build in the Habblaud repo');
    return false;
  }
  if (!existsSync(entry)) {
    debug(`Habblaud entry missing: ${entry}`);
    return false;
  }
  const logDir = join(homeOf(), '.habblaud', 'logs');
  mkdirSync(logDir, { recursive: true });
  const out = join(logDir, 'server.out.log');
  const err = join(logDir, 'server.err.log');
  const outFd = openSync(out, 'a');
  const errFd = openSync(err, 'a');
  const child = spawn(cmd, args, {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: {
      ...process.env,
      HABBLAUD_PORT: String(port),
      HABBLAUD_HOST: '127.0.0.1',
    },
    windowsHide: true,
  });
  child.unref();
  debug(`started Habblaud pid=${child.pid} entry=${entry}`);
  return true;
}

async function ensureRunning(cfg) {
  if (await health(cfg.port)) return true;
  if (!startDetached(cfg.rootDir, cfg.port)) return false;
  const start = Date.now();
  while (Date.now() - start < ENSURE_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 400));
    if (await health(cfg.port)) return true;
  }
  return false;
}

function normalizeEvent(raw, hookName) {
  const input = isObject(raw) ? raw : {};
  const event = {
    hook_event_name: hookName || str(input.hook_event_name) || str(input.event_name) || 'unknown',
    session_id: str(input.session_id) || str(input.conversation_id) || str(input.chat_id),
    conversation_id: str(input.conversation_id) || str(input.session_id),
    cwd: str(input.cwd) || (Array.isArray(input.workspace_roots) ? str(input.workspace_roots[0]) : undefined),
    workspace_roots: Array.isArray(input.workspace_roots) ? input.workspace_roots.map(str).filter(Boolean) : undefined,
    transcript_path: str(input.transcript_path) || str(input.transcriptPath),
    tool_name: str(input.tool_name) || str(input.toolName) || str(input.tool),
  };
  return clipDeep(event);
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function detectHookName(input, argv) {
  return (
    str(input?.hook_event_name) ||
    str(input?.event_name) ||
    str(process.env.CURSOR_HOOK_EVENT) ||
    str(argv[2]) ||
    'sessionStart'
  );
}

async function main() {
  const cfg = readConfig();
  const rawText = await readStdin();
  let raw;
  try {
    raw = rawText.trim() ? JSON.parse(rawText) : {};
  } catch {
    raw = {};
  }
  const hookName = detectHookName(raw, process.argv);
  // Keep Habblaud up on every agent session.
  try {
    await ensureRunning(cfg);
  } catch (err) {
    debug(`ensure failed: ${err?.message || err}`);
  }

  const event = normalizeEvent(raw, hookName);
  if (event.session_id) {
    try {
      await fetchJson(`http://127.0.0.1:${cfg.port}/api/cursor/events`, { account: '.cursor', event }, EVENT_TIMEOUT_MS);
    } catch (err) {
      debug(`event post failed: ${err?.message || err}`);
    }
  }

  // Fail open: empty JSON object is fine for observe-only hooks.
  process.stdout.write('{}\n');
}

main().catch(() => {
  try {
    process.stdout.write('{}\n');
  } catch {
    // ignore
  }
  process.exit(0);
});
