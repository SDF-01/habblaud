// Fonte de agentes do Cursor (AgentSource 'cursor'): descobre sessões de agentes do Cursor IDE a partir dos
// transcripts JSONL em ~/.cursor/projects/*/agent-transcripts/ e aceita eventos de hook via HTTP.
//
// Presença: um JSONL com mtime recente (dentro de `recentMs`) ou um evento de hook recente.
// Boot curto e síncrono; polling a cada `pollMs`.
import { basename, dirname } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import { cursorProjectsRoot, decodeCursorProjectSlug, discoverCursorProjects, listTranscriptFiles } from './discover';
import { parseCursorLine } from './transcript';
import { tr } from '../../../shared/i18n';

/** Um evento de hook segura o agente presente por este tempo (sem atividade no JSONL). */
const HOOK_PRESENCE_MS = 60_000;
/** Agente encerrado: remove depois deste tempo sem atividade. */
const CLOSE_AFTER_MISSING_MS = 5_000;

const MAIN_ROLE = tr('Agente principal (Cursor)');

export interface CursorLive {
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas de projetos do Cursor (cada uma com agent-transcripts/). */
  projectDirs: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pollMs?: number;
  /** Janela de atividade recente (default 30 min). */
  recentMs?: number;
}

interface SessionTracker {
  key: string;
  sessionId: string;
  projectDir: string;
  cwd: string;
  tail?: FileTail;
  tailPath?: string;
  inOffice: boolean;
  status: AgentStatus;
  statusAt: number;
  seq: number;
  lastAt: number;
  lastHookAt?: number;
  hookCwd?: string;
  missingSince?: number;
  stats: { toolCalls: number };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class CursorSource implements AgentSource, CursorLive {
  readonly provider = 'cursor' as const;
  private readonly sessions = new Map<string, SessionTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly recentMs: number;
  private readonly projectsRoot: string;
  private readonly home: string;
  private stopped = false;
  private error?: string;

  constructor(private readonly opts: CursorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2_000;
    this.recentMs = opts.recentMs ?? 30 * 60_000;
    this.home = opts.home ?? '';
    this.projectsRoot = cursorProjectsRoot(this.home);
    this.register();
  }

  private register(): void {
    this.opts.accounts.setProviderAccounts('cursor', [
      {
        dir: this.projectsRoot,
        detected: {
          id: '.cursor',
          configDir: this.projectsRoot,
          short: 'R',
          name: 'Cursor',
          color: '#38bdf8',
          provider: 'cursor',
        },
      },
    ]);
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.pollMs);
    this.timer.unref?.();
  }

  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll();
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.sessions.values()) if (t.inOffice) sessions++;
    const info: SourceInfo = { label: '.cursor', provider: 'cursor', path: this.projectsRoot, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    return t?.inOffice ? t.tailPath : undefined;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll();
    } catch (err) {
      log.warnOnce(`cursor-poll:${errMsg(err)}`, tr('Cursor: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  private poll(): void {
    const now = this.now();
    const seen = new Set<string>();
    // Novos projetos do Cursor aparecem enquanto o servidor roda: rediscobre a cada ciclo.
    const projectDirs = discoverCursorProjects(this.opts.env ?? process.env, this.home);
    const dirs = projectDirs.length ? projectDirs : this.opts.projectDirs;

    for (const projectDir of dirs) {
      try {
        const files = listTranscriptFiles(projectDir);
        const projectSlug = basename(projectDir);

        for (const file of files) {
          // Só arquivos recentes OU com hooks recentes
          const key = `.cursor:${file.sessionId}`;
          const existing = this.sessions.get(key);
          const hookRecent = existing?.lastHookAt !== undefined && now - existing.lastHookAt < HOOK_PRESENCE_MS;
          if (now - file.mtimeMs > this.recentMs && !hookRecent) continue;

          seen.add(key);
          let t = existing;
          if (!t) {
            const cwd = decodeCursorProjectSlug(projectSlug);
            t = {
              key,
              sessionId: file.sessionId,
              projectDir,
              cwd,
              inOffice: false,
              status: 'idle',
              statusAt: 0,
              seq: 0,
              lastAt: file.mtimeMs,
              stats: { toolCalls: 0 },
            };
            this.sessions.set(key, t);
          }

          // Ler o transcript
          if (!t.tail || t.tailPath !== file.path) {
            t.tail = new FileTail(file.path);
            t.tailPath = file.path;
            t.tail.seekTail(256 * 1024);
            // Leitura inicial: drena sem emitir ao vivo
            for (let i = 0; i < 64; i++) {
              const r = t.tail.read();
              for (const line of r.lines) {
                const result = parseCursorLine(line, t.seq++);
                if (result) {
                  if (result.statusHint) {
                    t.status = result.statusHint === 'working' ? 'working' : 'idle';
                    t.statusAt = result.at;
                  }
                  for (const a of result.activities) t.stats.toolCalls++;
                  t.lastAt = result.at;
                }
              }
              if (!r.more) break;
            }
          } else {
            // Leitura incremental
            for (let i = 0; i < 4; i++) {
              const r = t.tail.read();
              for (const line of r.lines) {
                const result = parseCursorLine(line, t.seq++);
                if (result) {
                  if (result.statusHint) {
                    t.status = result.statusHint === 'working' ? 'working' : 'idle';
                    t.statusAt = result.at;
                  }
                  t.lastAt = result.at;
                  if (t.inOffice) {
                    for (const a of result.activities) {
                      t.stats.toolCalls++;
                      this.opts.office.addActivity(t.key, a.activity, a.current);
                    }
                    if (result.statusHint) {
                      this.opts.office.setStatus(t.key, t.status);
                    }
                  }
                }
              }
              if (!r.more) break;
            }
          }

          delete t.missingSince;

          // Entra no escritório se ainda não está
          if (!t.inOffice) {
            const cwd = t.hookCwd ?? t.cwd;
            this.opts.office.addMain({
              id: t.key,
              provider: 'cursor',
              account: '.cursor',
              sessionId: t.sessionId,
              cwd,
              role: MAIN_ROLE,
              startedAt: t.lastAt,
              status: t.status,
            });
            t.inOffice = this.opts.office.has(t.key);
            if (t.inOffice) {
              const summary: TranscriptSummary = {
                tasks: [],
                stats: { toolCalls: t.stats.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 },
              };
              this.opts.office.applyTranscript(t.key, summary);
            }
          }
        }
      } catch (err) {
        this.error = errMsg(err);
      }
    }

    // Sessões que desapareceram
    for (const [key, t] of [...this.sessions]) {
      if (seen.has(key)) continue;
      // Hook recente mantém presente
      if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) {
        seen.add(key);
        continue;
      }
      t.missingSince ??= now;
      if (now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      if (t.inOffice) {
        this.opts.office.setStatus(t.key, 'offline');
        this.opts.office.closeMain(t.key);
        t.inOffice = false;
      }
      this.sessions.delete(key);
    }
  }

  // ---------------------------------------------------------------- hooks (CursorLive)

  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(input);
    } catch (err) {
      log.warnOnce(`cursor-hook:${errMsg(err)}`, tr('Cursor: evento de hook ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private hookEvent(input: Record<string, unknown>): boolean {
    const event = str(input.hook_event_name) ?? str(input.event_name);
    if (!event) return false;

    const sessionId = str(input.session_id) ?? str(input.conversation_id);
    if (!sessionId) return false;

    const now = this.now();
    const cwd = str(input.cwd) ?? (Array.isArray(input.workspace_roots) ? str(input.workspace_roots[0]) : undefined);
    const key = `.cursor:${sessionId}`;

    let t = this.sessions.get(key);
    if (!t) {
      t = {
        key,
        sessionId,
        projectDir: '',
        cwd: cwd ?? '',
        inOffice: false,
        status: 'idle',
        statusAt: 0,
        seq: 0,
        lastAt: now,
        stats: { toolCalls: 0 },
      };
      this.sessions.set(key, t);
    }

    t.lastHookAt = now;
    t.lastAt = now;
    delete t.missingSince;
    if (cwd) {
      t.hookCwd = cwd;
      t.cwd = cwd;
    }

    // Dica do transcript_path
    if (str(input.transcript_path) && !t.tailPath) {
      const tp = str(input.transcript_path)!;
      t.tailPath = tp;
    }

    const lower = event.toLowerCase();
    if (lower === 'sessionstart' || lower === 'beforesubmitprompt') {
      t.status = 'working';
      t.statusAt = now;
    } else if (lower === 'pretooluse' || lower === 'posttooluse') {
      t.status = 'working';
      t.statusAt = now;
    } else if (lower === 'stop') {
      t.status = 'idle';
      t.statusAt = now;
    } else if (lower === 'sessionend') {
      t.status = 'offline';
      t.statusAt = now;
    }

    // Entra no escritório assim que o hook traz um cwd (não espera o JSONL).
    if (!t.inOffice && (t.hookCwd || t.cwd) && lower !== 'sessionend') {
      this.opts.office.addMain({
        id: t.key,
        provider: 'cursor',
        account: '.cursor',
        sessionId: t.sessionId,
        cwd: t.hookCwd ?? t.cwd,
        role: MAIN_ROLE,
        startedAt: now,
        status: t.status === 'offline' ? 'idle' : t.status,
      });
      t.inOffice = this.opts.office.has(t.key);
    }

    if (t.inOffice) {
      if (lower === 'pretooluse' || lower === 'posttooluse') {
        this.opts.office.setStatus(t.key, 'working');
        const toolName = str(input.tool_name);
        if (toolName) {
          const act: Activity = {
            id: `${t.key}#hook${now.toString(36)}`,
            kind: 'other',
            icon: '🔧',
            text: toolName.length > 46 ? `${toolName.slice(0, 45)}…` : toolName,
            tool: toolName,
            at: now,
          };
          this.opts.office.addActivity(t.key, act, true);
        }
      } else if (lower === 'sessionend') {
        this.opts.office.setStatus(t.key, 'offline');
        this.opts.office.closeMain(t.key);
        t.inOffice = false;
      } else {
        this.opts.office.setStatus(t.key, t.status === 'offline' ? 'idle' : t.status);
      }
    }

    return true;
  }
}
