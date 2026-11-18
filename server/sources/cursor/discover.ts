// Descoberta de projetos do Cursor com transcripts de agentes: escaneia ~/.cursor/projects/*/agent-transcripts
// e lista os JSONL disponíveis. Aceita HABBLAUD_CURSOR_DIRS para apontar pastas manualmente.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';

/** Raiz dos projetos do Cursor: ~/.cursor/projects. */
export function cursorProjectsRoot(home: string): string {
  return join(home, '.cursor', 'projects');
}

/**
 * Descobre pastas de projetos do Cursor que têm `agent-transcripts`.
 * Com HABBLAUD_CURSOR_DIRS, usa essas pastas (separadas por vírgula ou ponto-e-vírgula no Windows);
 * senão escaneia o diretório padrão.
 */
export function discoverCursorProjects(env: NodeJS.ProcessEnv, home: string): string[] {
  const override = env.HABBLAUD_CURSOR_DIRS?.trim();
  if (override) {
    return override
      .split(/[;,]/)
      .map((d) => d.trim())
      .filter((d) => d && existsSync(join(d, 'agent-transcripts')));
  }
  const root = cursorProjectsRoot(home);
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(full, 'agent-transcripts'))) dirs.push(full);
    }
  } catch {
    // raiz inacessível
  }
  return dirs;
}

/**
 * Decodifica um slug de projeto do Cursor: `c-Users-User-Desktop-proj` → `C:\Users\User\Desktop\proj` (Windows)
 * ou `Users-ana-proj` → `/Users/ana/proj` (macOS/Linux). Melhor esforço; pode não ser exato.
 */
export function decodeCursorProjectSlug(slug: string): string {
  const parts = slug.split('-');
  // Windows: começa com uma letra sozinha (a unidade), ex. "c-Users-..."
  if (parts.length >= 2 && /^[a-zA-Z]$/.test(parts[0])) {
    return `${parts[0].toUpperCase()}:${sep}${parts.slice(1).join(sep)}`;
  }
  // Unix: "Users-ana-proj" → "/Users/ana/proj"
  return sep + parts.join(sep);
}

/** Lista recursiva de *.jsonl em agent-transcripts/ de uma pasta de projeto. */
export function listTranscriptFiles(projectDir: string): Array<{ path: string; sessionId: string; mtimeMs: number }> {
  const transcriptsDir = join(projectDir, 'agent-transcripts');
  if (!existsSync(transcriptsDir)) return [];
  const results: Array<{ path: string; sessionId: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(transcriptsDir)) {
      const entryPath = join(transcriptsDir, entry);
      try {
        const st = statSync(entryPath);
        if (st.isDirectory()) {
          // Subdiretório: procura uuid.jsonl dentro (padrão uuid/uuid.jsonl)
          const inner = join(entryPath, `${entry}.jsonl`);
          try {
            const ist = statSync(inner);
            if (ist.isFile()) {
              results.push({ path: inner, sessionId: entry, mtimeMs: ist.mtimeMs });
              continue;
            }
          } catch {
            // sem o padrão uuid/uuid.jsonl: procura qualquer .jsonl
          }
          try {
            for (const f of readdirSync(entryPath)) {
              if (!f.endsWith('.jsonl')) continue;
              const fp = join(entryPath, f);
              try {
                const fst = statSync(fp);
                if (fst.isFile()) {
                  results.push({ path: fp, sessionId: f.replace(/\.jsonl$/, ''), mtimeMs: fst.mtimeMs });
                }
              } catch {
                // inacessível
              }
            }
          } catch {
            // dir ilegível
          }
        } else if (st.isFile() && entry.endsWith('.jsonl')) {
          results.push({ path: entryPath, sessionId: entry.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs });
        }
      } catch {
        // inacessível
      }
    }
  } catch {
    // dir ilegível
  }
  return results;
}
