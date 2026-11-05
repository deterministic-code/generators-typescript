import type { ParsedSettings } from "../../read-settings.ts";
/** A single generated source file: its output path and full text content. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** The dispatched generate payload each datasource-validator `createGenerator().generate` receives: the resolved settings tree plus the datasource-type source it renders. */
export interface DatasourceValidatorGenerateConfig {
  settings: ParsedSettings;
  language?: string;
  datasourceTypes?: { types?: unknown[] };
  [key: string]: unknown;
}

/** The subset of a datasource field definition every validator generator reads to derive nullability, length, and range checks. */
export interface ValidatorFieldDef {
  type: string;
  min_size?: number;
  size?: number;
  references?: unknown;
  is_nullable?: boolean;
}

/** The system columns injected into every datasource table, in generate order — the schema-level generators (TS/C#) key their standard-column rules off this. */
export const STANDARD_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "id", type: "number" },
  { name: "uuid", type: "string" },
  { name: "created", type: "datetime" },
  { name: "updated", type: "datetime" },
];
