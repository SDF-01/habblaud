import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { Office } from '../model/office';
import { NameStore } from '../model/names';
import { CursorSource } from '../sources/cursor/source';

function makeJsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('CursorSource', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  it('descobre um transcript JSONL e cria um agente no escritório', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cursor-test-'));
    const projectDir = join(tmp, 'c-Users-Test-proj');
    mkdirSync(projectDir, { recursive: true });
    const transcriptsDir = join(projectDir, 'agent-transcripts');
    mkdirSync(transcriptsDir, { recursive: true });
    const sessionDir = join(transcriptsDir, 'abc123');
    mkdirSync(sessionDir, { recursive: true });

    const jsonl = makeJsonl([
      { role: 'user', message: { content: [{ type: 'text', text: 'Crie um servidor' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'npm init' } }] } },
    ]);
    writeFileSync(join(sessionDir, 'abc123.jsonl'), jsonl);

    const names = new NameStore(':memory:');
    const accounts = new AccountsService({
      dirs: [],
      home: tmp,
      env: {},
      usageDir: join(tmp, 'usage'),
      onChange: () => {},
    });
    const office = new Office({
      names,
      version: '0.0.0-test',
      startedAt: Date.now(),
      accounts: () => accounts.list(new Map()),
      sources: () => [],
      accountName: () => undefined,
    });

    let now = Date.now();
    const source = new CursorSource({
      accounts,
      office,
      projectDirs: [projectDir],
      home: tmp,
      now: () => now,
      pollMs: 100_000,
      recentMs: 60 * 60_000,
    });
    cleanup.push(() => source.stop());

    source.boot();

    const agents = office.list();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const cursor = agents.find((a) => a.provider === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.id).toBe('.cursor:abc123');
    expect(cursor!.account).toBe('.cursor');
  });

  it('aplica eventos de hook', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cursor-hook-'));
    const projectDir = join(tmp, 'c-Users-Test-proj');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true });

    const names = new NameStore(':memory:');
    const accounts = new AccountsService({
      dirs: [],
      home: tmp,
      env: {},
      usageDir: join(tmp, 'usage'),
      onChange: () => {},
    });
    const office = new Office({
      names,
      version: '0.0.0-test',
      startedAt: Date.now(),
      accounts: () => accounts.list(new Map()),
      sources: () => [],
      accountName: () => undefined,
    });

    const source = new CursorSource({
      accounts,
      office,
      projectDirs: [projectDir],
      home: tmp,
      pollMs: 100_000,
      recentMs: 60 * 60_000,
    });
    cleanup.push(() => source.stop());

    source.boot();

    const ok = source.applyHookEvent(undefined, {
      hook_event_name: 'SessionStart',
      session_id: 'hook-sess-1',
      cwd: '/Users/Test/proj',
    });
    expect(ok).toBe(true);
  });
});
