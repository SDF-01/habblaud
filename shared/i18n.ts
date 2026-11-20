// Interface languages. Portuguese (pt-BR) remains the source language for tr() keys: each string is written in PT
// and tr() returns the active-language translation, or the PT source if missing (so incomplete dictionaries never blank the UI).
//
// This fork defaults to English:
// - browser: saved preference (Settings > Language), else browser languages, else English;
// - server: HABBLAUD_LANG, else system language (LC_ALL / LC_MESSAGES / LANG / Intl), else English.
// Activity texts are built on the server, so they follow the server locale.
import { DICTIONARIES } from './locales/all';

export type Locale = 'pt-BR' | 'en' | 'es' | 'fr';

/** Selector order; each language name stays in that language so people can find theirs. */
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'pt-BR', name: 'Português' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
];

/** Chave da preferência salva no navegador. */
export const LOCALE_STORAGE_KEY = 'habblaud:locale';

/** Dicionários disponíveis (o PT não tem: é a língua de origem). No navegador começa vazio: ver registerDictionary. */
const DICTS: Partial<Record<Locale, Readonly<Record<string, string>>>> = { ...DICTIONARIES };

/** O navegador carrega só o dicionário do idioma ativo e o registra aqui antes de montar a interface. */
export function registerDictionary(l: Locale, dict: Readonly<Record<string, string>>): void {
  DICTS[l] = dict;
}

/** "fr-FR", "fr_CA.UTF-8", "pt", "pt_BR"... -> idioma suportado; undefined se não for nenhum deles. */
export function normalizeLocale(v: string | null | undefined): Locale | undefined {
  const s = (v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return undefined;
  if (s === 'fr' || s.startsWith('fr-')) return 'fr';
  if (s === 'pt' || s.startsWith('pt-')) return 'pt-BR';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'es' || s.startsWith('es-')) return 'es';
  return undefined;
}

/**
 * Server locale (activities, notices, logs). HABBLAUD_LANG wins for any language. Otherwise use the system locale
 * (LC_ALL, LC_MESSAGES, LANG, then Intl), including English. Default for this fork: English.
 */
export function serverLocale(env: Record<string, string | undefined>, intl?: string): Locale {
  const own = normalizeLocale(env.HABBLAUD_LANG);
  if (own) return own;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG, intl]) {
    const n = normalizeLocale(v);
    if (n) return n;
  }
  return 'en';
}

function detect(): Locale {
  const g = globalThis as {
    window?: unknown;
    localStorage?: { getItem(k: string): string | null };
    navigator?: { languages?: readonly string[]; language?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.window !== undefined) {
    try {
      const saved = normalizeLocale(g.localStorage?.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // localStorage blocked (private mode, iframe): fall through to browser languages.
    }
    for (const l of g.navigator?.languages ?? [g.navigator?.language ?? '']) {
      const n = normalizeLocale(l);
      if (n) return n;
    }
    return 'en';
  }
  const env = g.process?.env ?? {};
  // Tests assert Portuguese source strings: stay on PT regardless of the host machine.
  if (env.VITEST) return normalizeLocale(env.HABBLAUD_LANG_TEST) ?? 'pt-BR';
  let intl: string | undefined;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    intl = undefined;
  }
  return serverLocale(env, intl);
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

/** Troca o idioma ativo (testes; no navegador, a troca pela interface recarrega a página). */
export function setLocale(l: Locale): void {
  current = l;
}

/**
 * Translate a Portuguese source string. Numbered gaps ({0}, {1}...) take `args` in order; translations may reorder them.
 * Missing translation returns the source. Newlines are normalized so Windows CRLF keys still match locale files.
 */
export function tr(src: string, args?: readonly unknown[]): string {
  const dict = DICTS[current];
  const key = src.includes('\r') ? src.replace(/\r\n/g, '\n') : src;
  const s = (dict && (dict[key] || dict[src])) || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Idioma no formato do Intl (datas, números). */
export function intlLocale(): string {
  return current === 'fr' ? 'fr-FR' : current === 'en' ? 'en-US' : current === 'es' ? 'es' : 'pt-BR';
}
