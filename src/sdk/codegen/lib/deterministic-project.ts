import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathExists } from "../../path-exists.ts";
import { DEFAULT_SQL_DIALECT, normalizeDialect } from "../../lib/generate-sql.ts";

interface CliArgs {
  deterministicDir?: string;
  input?: string;
  dialects?: string[];
  [flag: string]: unknown;
}

interface ProjectSettings {
  backend?: { datasources?: unknown };
  datasource?: unknown;
}

interface ValidationError {
  line: number;
  col: number;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  data?: unknown;
}

type Validator = (text: string) => ValidationResult | Promise<ValidationResult>;

interface ResolveSiblingOptions {
  args: CliArgs;
  inputPath: string;
  flag: string;
  fileName: string;
  deterministicDir?: string | null;
  required?: boolean;
  scriptLabel?: string;
}

/** Resolve the `deterministic/` dir a script reads settings and inputs from: explicit `--deterministic-dir`, else the directory of `--input`, else the process-cwd default. */
export function resolveDeterministicDir(args: CliArgs): string {
  if (args.deterministicDir) return resolve(args.deterministicDir);
  if (args.input) return dirname(resolve(args.input));
  return join(process.cwd(), "deterministic");
}

export function validateOrExit(path: string, result: ValidationResult): void {
  if (result.valid) return;
  for (const err of result.errors) {
    process.stderr.write(`${path}:${err.line}:${err.col}: ${err.message}\n`);
  }
  process.stderr.write(
    `\n${result.errors.length} validation error(s) in ${path}; aborting.\n`,
  );
  process.exit(1);
}

export async function loadValidated(
  path: string,
  validator: Validator,
): Promise<unknown> {
  const text = await readFile(path, "utf8");
  const result = await validator(text);
  validateOrExit(path, result);
  return result.data;
}

/** The dialect axis for a datasource SQL step: an explicit `--dialects` wins, else the project-wide `settings.backend.datasources` list, else a single default dialect. */
export function resolveDatasourceDialects(
  args: CliArgs,
  settings?: ProjectSettings,
): string[] {
  if (args.dialects?.length) return args.dialects;
  if (Array.isArray(settings?.backend?.datasources)) {
    return settings.backend.datasources;
  }
  return [DEFAULT_SQL_DIALECT];
}

/** The dialect list with sqlite appended when absent. The integration and verify tiers always boot on sqlite (`--provider sqlite`, `sql/sqlite/migrations`) regardless of configured dialects, so the generated schema and the migrate runner's dispatch/driver lanes must both carry sqlite — otherwise the runner rejects `--provider sqlite` ("unsupported provider: sqlite") on the very migrations the schema generated. Deployment defaults (`.env` DATABASE_BACKEND, docker) stay on the configured production dialects, so this is applied only to the runner-support builders, not the whole migrate generate. */
export function withSqliteDialect(dialects: string[]): string[] {
  return dialects.some((d) => normalizeDialect(d) === "sqlite")
    ? dialects
    : [...dialects, "sqlite"];
}

/** The sqlite-inclusive schema dialects resolved from settings — see `withSqliteDialect`. */
export function resolveSchemaDialects(
  args: CliArgs,
  settings?: ProjectSettings,
): string[] {
  return withSqliteDialect(resolveDatasourceDialects(args, settings));
}

const SIBLING_FLAG_CLI: Record<string, string> = {
  viewTypes: "--view-types",
  datasourceTypes: "--datasource-types",
};

export async function resolveSibling({
  args,
  inputPath,
  flag,
  fileName,
  deterministicDir,
  required = true,
  scriptLabel = "this script",
}: ResolveSiblingOptions): Promise<string | null> {
  if (args[flag]) return resolve(args[flag] as string);
  const candidates = [];
  if (deterministicDir) candidates.push(join(deterministicDir, fileName));
  candidates.push(join(dirname(inputPath), fileName));
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  if (!required) return null;
  const flagCli = SIBLING_FLAG_CLI[flag] ?? `--${flag}`;
  const locDesc = deterministicDir
    ? `${deterministicDir} or beside ${inputPath}`
    : `beside ${inputPath}`;
  console.error(
    `${scriptLabel} requires ${fileName}; none was found in ${locDesc}. Pass ${flagCli} <path> to resolve.`,
  );
  process.exit(2);
}
