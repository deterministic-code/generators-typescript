import { isWriteDtoViewName } from "../../sdk/lib/schema-build.ts";
import { buildFrontendComponents } from "./frontend-type-components.ts";
import { layoutForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import {
  readBindings,
  bindingDatasource,
  refName,
} from "./frontend-bindings-routes.ts";
import { CONTENT } from "../../sdk/codegen/lib/generate-result.ts";
import type { GenerateArgs, SchemaProp } from "./frontend-generate-types.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import type { CodegenFieldNames } from "../../sdk/field-names.ts";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";

const SCHEMA_VERSION = "1.0";

interface RenderOpts {
  names: CodegenNames;
  fields: CodegenFieldNames;
  datetime: string;
  generatedNames: Set<string>;
}

type TypeCtx = RenderOpts & { layout: CodegenLayout; datasource: string };

interface ReadTypeModel {
  components: Record<string, SchemaProp>;
  opts: RenderOpts;
  sorted: { name: string; className: string }[];
  layout: CodegenLayout;
}

function scalarTs(prop: SchemaProp, datetime: string): string {
  switch (prop.type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return prop.format === "date-time" && datetime === "native"
        ? "Date"
        : "string";
    default:
      throw new Error(
        `frontend_types: unmapped schema property ${JSON.stringify(prop)}`,
      );
  }
}

function schemaPropToTs(prop: SchemaProp, opts: RenderOpts): string {
  if (prop.$ref) return opts.names.className(refName(prop.$ref));
  if (prop.oneOf) {
    return prop.oneOf.map((m) => schemaPropToTs(m, opts)).join(" | ");
  }
  if (prop.type === "array") return `${schemaPropToTs(prop.items!, opts)}[]`;
  if (prop.enum && prop.type === "string") {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  return scalarTs(prop, opts.datetime);
}

function fieldLine(key: string, prop: SchemaProp, opts: RenderOpts): string {
  const nullable = prop.nullable === true ? " | null" : "";
  return `  ${opts.fields.ident(key)}: ${schemaPropToTs(prop, opts)}${nullable};`;
}

function renderComponent(
  name: string,
  schema: SchemaProp,
  opts: RenderOpts,
): string {
  const className = opts.names.className(name);
  if (schema.oneOf) {
    const members = schema.oneOf
      .map((m) => schemaPropToTs(m, opts))
      .join(" | ");
    return `export type ${className} = ${members};`;
  }
  const props = schema.properties ?? {};
  const lines = Object.keys(props).map((key) =>
    fieldLine(key, props[key], opts),
  );
  const body = lines.length ? `\n${lines.join("\n")}\n` : "";
  return `export interface ${className} {${body}}`;
}

/** The component names a schema references via `$ref` (through properties, array items, and one_of members) — the sibling read-types this one must import now that each lives in its own file. */
function collectRefNames(
  schema: SchemaProp | null | undefined,
  acc = new Set<string>(),
): Set<string> {
  if (!schema || typeof schema !== "object") return acc;
  if (schema.$ref) acc.add(refName(schema.$ref));
  if (schema.oneOf) schema.oneOf.forEach((m) => collectRefNames(m, acc));
  if (schema.items) collectRefNames(schema.items, acc);
  if (schema.properties) {
    Object.values(schema.properties).forEach((p) => collectRefNames(p, acc));
  }
  return acc;
}

function typeFilePath(ctx: TypeCtx, name: string): string {
  return ctx.layout.frontendTypesFile(
    ctx.datasource,
    `${ctx.names.casedFileStem(name)}.ts`,
  );
}

function importLines(name: string, schema: SchemaProp, ctx: TypeCtx): string[] {
  const fromFile = typeFilePath(ctx, name);
  const refs = [...collectRefNames(schema)]
    .filter((ref) => ref !== name && ctx.generatedNames.has(ref))
    .map((ref) => ({
      symbol: ctx.names.className(ref),
      spec: ctx.layout.frontendRelImport(fromFile, typeFilePath(ctx, ref)),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return refs.map((r) => `import type { ${r.symbol} } from "${r.spec}";`);
}

function typeFileBody(name: string, schema: SchemaProp, ctx: TypeCtx): string {
  const imports = importLines(name, schema, ctx);
  const header = imports.length ? `${imports.join("\n")}\n\n` : "";
  return `${header}${renderComponent(name, schema, ctx)}\n`;
}

function barrelBody(sorted: ReadTypeModel["sorted"], ctx: TypeCtx): string {
  const barrelFile = ctx.layout.frontendTypesFile(ctx.datasource, "index.ts");
  const exports = sorted.map(({ name, className }) => {
    const spec = ctx.layout.frontendRelImport(
      barrelFile,
      typeFilePath(ctx, name),
    );
    return `export type { ${className} } from "${spec}";`;
  });
  return `// schema-version: ${SCHEMA_VERSION}\n\n${exports.join("\n")}\n`;
}

/** The read-type surface shared by every datasource: the entity/view components (write-body DTOs filtered out), sorted by class name, plus the rendering `opts` and the `CodegenLayout`. Built once from the OpenAPI oracle so per-datasource placement is the only thing that varies. Exposed for unit tests that assert the rendered bodies without touching disk. */
export async function buildReadTypeModel({
  inputs,
  settings,
}: GenerateArgs): Promise<ReadTypeModel> {
  const { components, names, fields, datetime } = await buildFrontendComponents(
    { inputs, settings },
  );
  const readNames = Object.keys(components).filter(
    (name) => !isWriteDtoViewName(name),
  );
  const opts: RenderOpts = {
    names,
    fields,
    datetime,
    generatedNames: new Set(readNames),
  };
  const sorted = readNames
    .map((name) => ({ name, className: names.className(name) }))
    .sort((a, b) => a.className.localeCompare(b.className));
  return {
    components: components as Record<string, SchemaProp>,
    opts,
    sorted,
    layout: layoutForSettings(settings, "typescript"),
  };
}

/** One file per read type plus a re-exporting `index.ts` barrel, under the shared `bindings/<datasource>/types/` dir in both layout modes. Pure — placement + specifiers flow through `layout`. */
export function datasourceTypeEntries(
  datasource: string,
  { components, opts, sorted, layout }: ReadTypeModel,
) {
  const ctx: TypeCtx = { ...opts, layout, datasource };
  const typeEntries = sorted.map(({ name }) => ({
    kind: CONTENT,
    filename: typeFilePath(ctx, name),
    contents: typeFileBody(name, components[name], ctx),
  }));
  return [
    ...typeEntries,
    {
      kind: CONTENT,
      filename: layout.frontendTypesFile(datasource, "index.ts"),
      contents: barrelBody(sorted, ctx),
    },
  ];
}

/** Generate the entity/view read types under `frontend/src/bindings/<datasource>/types/` — one file per type plus a barrel `index.ts` — for every datasource in `frontend_bindings.yaml`. The datasource is the type-sharing boundary, so each datasource folder is self-contained (a view type spanning entities still belongs to one datasource). No bindings → no frontend types, matching `client_bindings`/`frontend_validators`. Each type's flattened shape matches the OpenAPI `components/schemas` via `buildComponents` (the oracle), so frontend types can't drift from the backend contract; write-body DTOs (create/update/eager) are filtered out; casing flows through `CodegenNames`/`CodegenFieldNames`/`CodegenLayout` from settings. */
export async function generate({ inputs, settings }: GenerateArgs) {
  const { datasources } = await readBindings(inputs);
  if (datasources.length === 0) return { entries: [] };
  const model = await buildReadTypeModel({ inputs, settings });
  const entries = [];
  for (const entry of datasources) {
    const ds = bindingDatasource(entry);
    entries.push(...datasourceTypeEntries(ds.name, model));
  }
  return { entries };
}

export const entriesNative = true;

export const assembleAfterStep = true;
