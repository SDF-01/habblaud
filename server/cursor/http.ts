// Eventos dos hooks do Cursor (POST /api/cursor/events): recebe payloads com dados de sessão do Cursor IDE e
// repassa para a fonte do Cursor (CursorLive), que atualiza o agente na hora. Os eventos só observam (a resposta
// nunca volta para a sessão), mas só valem vindos do próprio computador.
//
//   POST /api/cursor/events   {account?, event: {hook_event_name|event_name, session_id|conversation_id, ...}}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CursorLive } from '../sources/cursor/source';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

export interface CursorHookEvent {
  account?: string;
  event: Rec;
}

/** Corpo de POST /api/cursor/events. */
export function parseCursorEvent(raw: unknown): CursorHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event) throw new HttpError(400, 'esperado {account?, event: <JSON do hook do Cursor>}');
  const eventName = shortStr(event.hook_event_name, 200) ?? shortStr(event.event_name, 200);
  if (!eventName) throw new HttpError(400, 'esperado event.hook_event_name ou event.event_name');
  const out: CursorHookEvent = { event };
  const account = shortStr(r.account, 200);
  if (account) out.account = account;
  return out;
}

/** Trata POST /api/cursor/events (método e Host já conferidos). */
export async function handleCursorEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: CursorLive },
): Promise<void> {
  const body = parseCursorEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(body.account, body.event) === true;
    } catch (err) {
      log.warnOnce(`cursor-event:${errMsg(err)}`, tr('Eventos do Cursor: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
