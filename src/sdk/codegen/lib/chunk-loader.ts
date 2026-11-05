import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = resolve(here, "..", "..", "templates");
const cache = new Map<string, string>();
const EXT: Record<string, string> = {
  rust: "rs",
  csharp: "cs",
  typescript: "ts",
  shell: "sh",
};

async function readCached(path: string): Promise<string> {
  if (!cache.has(path)) cache.set(path, await readFile(path, "utf8"));
  return cache.get(path)!;
}

export interface ChunkLoader {
  loadChunk(lang: string, name: string): Promise<string>;
  renderDialectMap(
    lang: string,
    chunkName: string,
    tokensByDialect: Record<string, Record<string, unknown>>,
  ): Promise<Record<string, string>>;
}

/** A chunk loader rooted at a `templates` dir — the generator pack that owns a language's create-backend-app chunks passes its own dir so its lanes read templates from the pack, not the SDK. */
export function makeChunkLoader(templatesDir: string): ChunkLoader {
  const loadChunk = async (lang: string, name: string): Promise<string> => {
    const ext = EXT[lang];
    if (!ext) throw new Error(`chunk-loader: unknown language "${lang}"`);
    const filename = name.includes(".") ? name : `${name}.${ext}`;
    const path = resolve(
      templatesDir,
      "create-backend-app",
      lang,
      "chunks",
      filename,
    );
    return (await readCached(path)).trimEnd();
  };
  const renderDialectMap = async (
    lang: string,
    chunkName: string,
    tokensByDialect: Record<string, Record<string, unknown>>,
  ): Promise<Record<string, string>> => {
    const template = await loadChunk(lang, chunkName);
    const out: Record<string, string> = {};
    for (const [d, tokens] of Object.entries(tokensByDialect)) {
      out[d] = applyTokens(template, tokens);
    }
    return out;
  };
  return { loadChunk, renderDialectMap };
}

const defaultLoader = makeChunkLoader(DEFAULT_TEMPLATES_DIR);

export const loadChunk = defaultLoader.loadChunk;
export const renderDialectMap = defaultLoader.renderDialectMap;

export function applyTokens(
  template: string,
  tokens: Record<string, unknown>,
): string {
  return Object.entries(tokens).reduce(
    (s, [k, v]) => s.replaceAll(`{{${k}}}`, String(v)),
    template,
  );
}

export async function renderTemplate(
  templatePath: string,
  tokens: Record<string, string>,
): Promise<string> {
  const text = await readFile(templatePath, "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in tokens)) {
      throw new Error(`Unresolved placeholder: {{${key}}} in ${templatePath}`);
    }
    return tokens[key];
  });
}
