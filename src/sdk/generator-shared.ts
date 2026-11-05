export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function entryOf(obj: Record<string, unknown>): [string, unknown] {
  const keys = Object.keys(obj);
  return [keys[0], obj[keys[0]]];
}

export function isFiniteInt(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

export function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function safeIdent(name: string): string {
  return IDENT_RE.test(name) ? name : JSON.stringify(name);
}

interface GroupedImportEntry {
  fromPath: string;
  original: string;
  alias?: string;
}

interface RenderGroupedImportsOptions {
  typeOnly?: boolean;
}

/** Group `{ fromPath, original, alias }` import entries by path into deduped, sorted `import [type] { ... } from "..."` lines. */
export function renderGroupedImports(
  entries: GroupedImportEntry[],
  { typeOnly = false }: RenderGroupedImportsOptions = {},
): string {
  const byPath = new Map<string, string[]>();
  for (const e of entries) {
    if (!byPath.has(e.fromPath)) byPath.set(e.fromPath, []);
    const token = e.alias ? `${e.original} as ${e.alias}` : e.original;
    byPath.get(e.fromPath)!.push(token);
  }
  const keyword = typeOnly ? "import type" : "import";
  const lines: string[] = [];
  for (const [path, tokens] of byPath) {
    const names = [...new Set(tokens)].sort().join(", ");
    lines.push(`${keyword} { ${names} } from "${path}";`);
  }
  return lines.sort().join("\n");
}
