import type { ParsedSettings } from "../../read-settings.ts";
import { renderDocComment } from "../../generate-doc-comment.ts";
import type { CodegenNames } from "../../codegen-naming.ts";
import type { CodegenFieldNames } from "../../field-names.ts";
import type { CodegenLayout } from "../../codegen-layout.ts";

/** A single generated source file: its output path and full text content. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** The render context the SDK `datasourceTypesGenerator` injects into every dialect's `renderTable`: the per-language `opts`, the SDK naming/layout owners, and (for dialects that generate import/using lines) the language `imports` helper. `TImports` defaults to `undefined` for dialects like rust that render no import lines. */
export interface GenerateCtx<TOpts, TImports = undefined> {
  opts: TOpts;
  names: CodegenNames;
  fields: CodegenFieldNames;
  layout: CodegenLayout;
  imports: TImports;
}

/** The datasource-type doc comment every dialect renders above the generated class/struct: a `Type <name>.` summary plus the datasource-type tag, `StandardCrud` target, and field count. `language` selects the dialect's comment syntax (defaulting to TypeScript). */
export function datasourceTypeDoc(spec: {
  className: string;
  datasourceType?: string;
  fieldCount: number;
  style: unknown;
  language?: string;
}): string {
  return renderDocComment({
    style: spec.style,
    summary: `Type ${spec.className}.`,
    lines: [
      `Datasource type: ${spec.datasourceType ?? "standard"}.`,
      `Target: StandardCrud.`,
      `Fields: ${spec.fieldCount}.`,
    ],
    language: spec.language,
  });
}

/** One normalized datasource-type field, in the shape every dialect generator reads after `normalizeTable`. `references` stays `unknown` — the id-vs-uuid decision is delegated to `DatasourceSettings.referenceIsUuid`. `isStandard` marks the injected system columns (id/uuid/created/updated). */
export interface DatasourceField {
  name: string;
  type: string;
  isNullable?: boolean;
  references?: unknown;
  isStandard?: boolean;
}

/** A datasource table after `normalizeTable`: its name, its optional datasource-type tag, and its ordered fields. */
export interface NormalizedTable {
  name: string;
  datasourceType?: string;
  fields: DatasourceField[];
}

/** The dispatched generate payload each datasource-types `render` receives: the resolved settings tree plus the parsed datasource-type source it renders. */
export interface DatasourceTypesGenerateConfig {
  settings: ParsedSettings;
  language?: string;
  datasourceTypes?: { types?: unknown[] };
  [key: string]: unknown;
}
