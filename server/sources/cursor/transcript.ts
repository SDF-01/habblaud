// Parser de linhas JSONL dos transcripts do Cursor (agent-transcripts/*.jsonl). Cada linha é um JSON com
// `role` ('user' | 'assistant') e `message.content` (array de blocos de texto e tool_use). Extrai atividades
// e dicas de status para a fonte do Cursor (source.ts).
import type { Activity, ActivityKind } from '../../../shared/types';

export interface CursorLineResult {
  activities: Array<{ activity: Activity; current: boolean }>;
  /** Dica de status: 'working' no início de turno do assistant, 'idle' no fim (texto sem tools). */
  statusHint?: 'working' | 'idle';
  at: number;
}

/** Mapeia o nome de uma ferramenta do Cursor para o ActivityKind do Habblaud. */
function toolKind(name: string): ActivityKind {
  const n = name.toLowerCase();
  if (n === 'shell' || n === 'bash' || n === 'awaitshell') return 'run';
  if (n === 'read' || n === 'readlints') return 'read';
  if (n === 'write' || n === 'strreplace' || n === 'editnotebook') return 'edit';
  if (n === 'grep' || n === 'glob') return 'search';
  if (n === 'websearch' || n === 'webfetch' || n === 'fetchmcpresource') return 'web';
  if (n === 'task') return 'delegate';
  if (n === 'todowrite') return 'plan';
  if (n === 'switchmode') return 'plan';
  if (n === 'generateimage') return 'other';
  if (n === 'delete') return 'edit';
  if (n === 'calldynamictool' || n === 'getdynamictools') return 'mcp';
  if (n.startsWith('browser_') || n.startsWith('cursor-ide-browser')) return 'browser';
  return 'other';
}

/** Ícone da atividade. */
function toolIcon(kind: ActivityKind): string {
  switch (kind) {
    case 'run': return '💻';
    case 'read': return '📖';
    case 'edit': return '✏️';
    case 'search': return '🔍';
    case 'web': return '🌐';
    case 'delegate': return '🤖';
    case 'plan': return '📋';
    case 'browser': return '🖥️';
    case 'mcp': return '🔌';
    default: return '🔧';
  }
}

/** Texto descritivo curto (até ~46 chars). */
function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  switch (name) {
    case 'Shell':
    case 'Bash': {
      const cmd = s(input.command) ?? s(input.description);
      return cmd ? truncate(`$ ${cmd}`, 46) : 'Shell';
    }
    case 'Read': {
      const p = s(input.path);
      return p ? truncate(`Lendo ${p}`, 46) : 'Lendo arquivo';
    }
    case 'Write': {
      const p = s(input.path);
      return p ? truncate(`Escrevendo ${p}`, 46) : 'Escrevendo arquivo';
    }
    case 'StrReplace': {
      const p = s(input.path);
      return p ? truncate(`Editando ${p}`, 46) : 'Editando arquivo';
    }
    case 'Grep': {
      const pat = s(input.pattern);
      return pat ? truncate(`Buscando "${pat}"`, 46) : 'Buscando no projeto';
    }
    case 'Glob': {
      const pat = s(input.glob_pattern);
      return pat ? truncate(`Buscando ${pat}`, 46) : 'Listando arquivos';
    }
    case 'WebSearch': {
      const q = s(input.query);
      return q ? truncate(`Pesquisando "${q}"`, 46) : 'Pesquisando na web';
    }
    case 'WebFetch': {
      const u = s(input.url);
      return u ? truncate(`Acessando ${u}`, 46) : 'Acessando URL';
    }
    case 'Task': {
      const d = s(input.description);
      return d ? truncate(`Tarefa: ${d}`, 46) : 'Disparando subagente';
    }
    case 'TodoWrite':
      return 'Atualizando tarefas';
    case 'CallDynamicTool': {
      const tool = s(input.toolName);
      return tool ? truncate(`MCP: ${tool}`, 46) : 'Chamando MCP';
    }
    default:
      return truncate(name, 46);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Analisa uma linha JSONL de um transcript do Cursor e extrai atividades e dica de status.
 * `seq` é um contador incremental para gerar ids únicos.
 */
export function parseCursorLine(line: string, seq: number): CursorLineResult | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const role = obj.role as string | undefined;
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const now = Date.now();

  if (role === 'user') {
    // Prompt do usuário: atividade de prompt, sinaliza início de trabalho
    let text = '';
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
          text = truncate(String((block as Record<string, unknown>).text ?? ''), 46);
          break;
        }
      }
    } else if (typeof content === 'string') {
      text = truncate(content, 46);
    }
    const activity: Activity = {
      id: `cursor-${seq}`,
      kind: 'prompt',
      icon: '💬',
      text: text || 'Prompt do usuário',
      at: now,
    };
    return { activities: [{ activity, current: true }], statusHint: 'working', at: now };
  }

  if (role === 'assistant') {
    if (!Array.isArray(content)) return null;

    const activities: Array<{ activity: Activity; current: boolean }> = [];
    let hasTools = false;

    for (let i = 0; i < content.length; i++) {
      const block = content[i] as Record<string, unknown> | undefined;
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        hasTools = true;
        const name = String(block.name ?? 'ferramenta');
        const input = block.input as Record<string, unknown> | undefined;
        const kind = toolKind(name);
        const activity: Activity = {
          id: `cursor-${seq}-${i}`,
          kind,
          icon: toolIcon(kind),
          text: toolLabel(name, input),
          tool: name,
          at: now,
        };
        activities.push({ activity, current: i === content.length - 1 });
      }
    }

    if (activities.length) {
      return { activities, statusHint: 'working', at: now };
    }

    // Texto sem ferramentas: fim do turno (idle)
    return { activities: [], statusHint: 'idle', at: now };
  }

  return null;
}
