import type { ParsedSettings } from "../../sdk/read-settings.ts";
import type { RawTypesDoc } from "../../sdk/deterministic-shapes.ts";
import { join } from "node:path";
import { parse } from "yaml";
import { parseDatasourceTypes } from "../../sdk/codegen/lib/parse-datasource-types.ts";
import {
  buildComponents,
  isWriteDtoViewName,
} from "../../sdk/lib/schema-build.ts";
import {
  namesForSettings,
  layoutForSettings,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { schemaSymbol, validatedSymbol } from "./zod-schema-names.ts";
import { datetimeOptionFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";
import {
  refName,
  readBindings,
  bindingDatasource,
  resolveSelfDoc,
  groupRowsByEntity,
} from "./frontend-bindings-routes.ts";
import {
  CONTENT,
  PATCH,
} from "../../sdk/codegen/lib/generate-result.ts";
import {
  BODY_METHODS,
  cap,
  fnNameOf,
  pathParamsOf,
  templatePath,
} from "./client-op-model.ts";
import type { CodegenNames } from "../../sdk/codegen-naming.ts";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";

type ResolvedSettings = ParsedSettings;

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
}

type Components = Record<string, SchemaObject>;

interface RouteRow {
  method: string;
  path: string;
  name?: string;
  request?: SchemaObject;
  response?: SchemaObject;
}

interface SchemaRef {
  parse: string;
  value: string;
  typeName: string;
  type: string;
  needsZod: boolean;
}

interface ClientOp {
  fnName: string;
  method: string;
  path: string;
  params: string[];
  requestType: string | null;
  responseType: string;
  requestParse: string | null;
  responseParse: string | null;
}

interface BaseCtx {
  names: CodegenNames;
  layout: CodegenLayout;
  importable: Set<string>;
  components: Components;
  validate: boolean;
  datetime: string;
}

interface ClientCtx extends BaseCtx {
  typesImport: string;
  validatorsImport: string;
}

interface FileCtx extends ClientCtx {
  imports: Set<string>;
  validatorValues: Set<string>;
  validatorTypes: Set<string>;
  needsZod: Set<string>;
}

interface ClientRenderer {
  render: (op: ClientOp) => string;
  prelude: (rows: RouteRow[]) => string;
}

interface GenerateInputs {
  all: () => Promise<{
    viewYamlText: string;
    datasourceYamlText: string | null;
  }>;
}

interface GenerateBase {
  names: CodegenNames;
  layout: CodegenLayout;
  importable: Set<string>;
  validate: boolean;
  inputs: GenerateInputs;
  settings: ResolvedSettings;
  datetime: string;
}

const CLIENT_LIBS = new Set(["fetch", "axios", "tanstack"]);

/** The npm dependency each client library needs in frontend/package.json — `fetch` is native so adds none. Merged add-if-absent, so a version frontend_app's skeleton already pins keeps precedence. */
const CLIENT_DEPS: Record<string, Record<string, string>> = {
  fetch: {},
  axios: { axios: "^1.7.9" },
  tanstack: { "@tanstack/react-query": "^5.66.0" },
};
const SCALAR_TS: Record<string, string> = {
  integer: "number",
  number: "number",
  boolean: "boolean",
  string: "string",
};

/** A `$ref` to a type frontend_types generates (a read entity/view) becomes that className and is added to `ctx.imports`; a `$ref` to a write-body DTO — which frontend_types does NOT generate — is inlined structurally instead of importing a symbol that wouldn't exist. The `seen` set guards against a self-referential DTO looping forever. */
function refType(ref: string, ctx: FileCtx, seen: Set<string>): string {
  const raw = refName(ref);
  const className = ctx.names.className(raw);
  if (ctx.importable.has(className)) {
    ctx.imports.add(className);
    return className;
  }
  if (seen.has(raw) || !ctx.components[raw]) return "unknown";
  return tsTypeFor(ctx.components[raw], ctx, new Set(seen).add(raw));
}

/** Map an OpenAPI response/request schema to a TS type, collecting the read types to import into `ctx.imports`. Arrays/inline objects render structurally; anything unmapped is `unknown` rather than a lie. */
function tsTypeFor(
  schema: SchemaObject | undefined,
  ctx: FileCtx,
  seen = new Set<string>(),
): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) return refType(schema.$ref, ctx, seen);
  if (schema.type === "array") {
    return `${tsTypeFor(schema.items, ctx, seen)}[]`;
  }
  if (schema.type === "object" && schema.properties) {
    const fields = Object.entries(schema.properties)
      .map(([key, value]) => `${key}: ${tsTypeFor(value, ctx, seen)}`)
      .join("; ");
    return `{ ${fields} }`;
  }
  if (schema.type === "string" && schema.format === "date-time") {
    return ctx.datetime === "native" ? "Date" : "string";
  }
  const scalar = schema.type ? SCALAR_TS[schema.type] : undefined;
  return scalar ?? "unknown";
}

/** The zod schema for a `$ref` (or array-of-`$ref`) body and the validated type it infers, or null for an inline/scalar body that has no named schema. `parse` is the runtime schema expression; `type` is the `z.infer` alias a validated response is typed as, so the client speaks the exact shape the schema guarantees instead of casting. */
function schemaRef(
  schema: SchemaObject | undefined,
  ctx: FileCtx,
): SchemaRef | null {
  if (!schema || typeof schema !== "object") return null;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return {
      parse: schemaSymbol(name, ctx.names),
      value: schemaSymbol(name, ctx.names),
      typeName: validatedSymbol(name, ctx.names),
      type: validatedSymbol(name, ctx.names),
      needsZod: false,
    };
  }
  if (schema.type === "array" && schema.items?.$ref) {
    const name = refName(schema.items.$ref);
    return {
      parse: `z.array(${schemaSymbol(name, ctx.names)})`,
      value: schemaSymbol(name, ctx.names),
      typeName: validatedSymbol(name, ctx.names),
      type: `${validatedSymbol(name, ctx.names)}[]`,
      needsZod: true,
    };
  }
  return null;
}

function recordValidatorImports(
  ref: SchemaRef,
  ctx: FileCtx,
  { withType }: { withType: boolean },
): void {
  ctx.validatorValues.add(ref.value);
  if (withType) ctx.validatorTypes.add(ref.typeName);
  if (ref.needsZod) ctx.needsZod.add("z");
}

function operationModel(row: RouteRow, ctx: FileCtx): ClientOp {
  const hasBody = BODY_METHODS.has(row.method);
  const requestType = row.request ? tsTypeFor(row.request, ctx) : null;
  const reqRef =
    ctx.validate && hasBody && row.request ? schemaRef(row.request, ctx) : null;
  const respRef =
    ctx.validate && row.response ? schemaRef(row.response, ctx) : null;
  if (reqRef) recordValidatorImports(reqRef, ctx, { withType: false });
  if (respRef) recordValidatorImports(respRef, ctx, { withType: true });
  return {
    fnName: fnNameOf(row),
    method: row.method,
    path: templatePath(row.path),
    params: pathParamsOf(row.path),
    requestType: hasBody ? requestType : null,
    responseType: respRef
      ? respRef.type
      : row.response
        ? tsTypeFor(row.response, ctx)
        : "void",
    requestParse: reqRef ? reqRef.parse : null,
    responseParse: respRef ? respRef.parse : null,
  };
}

function requestBodyExpr(op: ClientOp): string {
  return op.requestParse ? `${op.requestParse}.parse(body)` : "body";
}

/** A validated response is typed as the schema's inferred type, so `.parse()` returns exactly `op.responseType` and needs no cast; the un-validated branch keeps the frontend_types promise cast. */
function jsonResponseExpr(op: ClientOp): string {
  return op.responseParse
    ? `${op.responseParse}.parse(await response.json())`
    : `response.json() as Promise<${op.responseType}>`;
}

function signature(op: ClientOp): string {
  const parts = op.params.map((p) => `${p}: string | number`);
  if (op.requestType) parts.push(`body: ${op.requestType}`);
  return parts.join(", ");
}

/** The read types a client references all come from the datasource's shared `types/` barrel, so one `import type` line covers them; `typesImport` is the layout-resolved barrel specifier (`../types` flat, `../../types` by-feature). */
function importHeader(imports: Set<string>, typesImport: string): string {
  if (imports.size === 0) return "";
  const names = [...imports].sort((a, b) => a.localeCompare(b)).join(", ");
  return `import type { ${names} } from "${typesImport}";\n`;
}

function sortedList(set: Set<string>): string {
  return [...set].sort((a, b) => a.localeCompare(b)).join(", ");
}

/** The zod runtime + validator-barrel imports a file needs when generate_validators is on: schema values for `.parse()` and the `z.infer` types validated responses are annotated with. Empty (so the file is byte-identical to the un-validated output) when no schema was referenced. */
function validatorHeader(fileCtx: FileCtx, validatorsImport: string): string {
  const lines = [];
  if (fileCtx.needsZod.size > 0) lines.push(`import { z } from "zod";`);
  if (fileCtx.validatorValues.size > 0) {
    lines.push(
      `import { ${sortedList(fileCtx.validatorValues)} } from "${validatorsImport}";`,
    );
  }
  if (fileCtx.validatorTypes.size > 0) {
    lines.push(
      `import type { ${sortedList(fileCtx.validatorTypes)} } from "${validatorsImport}";`,
    );
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function fetchFn(op: ClientOp): string {
  const init = op.requestType
    ? `, {\n    method: "${op.method}",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify(${requestBodyExpr(op)}),\n  }`
    : op.method === "GET"
      ? ""
      : `, { method: "${op.method}" }`;
  const ret =
    op.responseType === "void" ? "" : `\n  return ${jsonResponseExpr(op)};`;
  return `export async function ${op.fnName}(${signature(op)}): Promise<${op.responseType}> {
  const response = await fetch(\`${op.path}\`${init});
  if (!response.ok) throw new Error(\`${op.method} ${op.path} -> \${response.status}\`);${ret}
}`;
}

function axiosFn(op: ClientOp): string {
  const verb = op.method.toLowerCase();
  const arg = op.requestType ? `, ${requestBodyExpr(op)}` : "";
  const ret = op.responseParse
    ? `  return ${op.responseParse}.parse(response.data);`
    : `  return response.data;`;
  return `export async function ${op.fnName}(${signature(op)}): Promise<${op.responseType}> {
  const response = await axios.${verb}<${op.responseType}>(\`${op.path}\`${arg});
${ret}
}`;
}

function tanstackQuery(op: ClientOp): string {
  const key = ['"' + op.fnName + '"', ...op.params].join(", ");
  return `export function use${cap(op.fnName)}(${signature(op)}) {
  return useQuery({
    queryKey: [${key}],
    queryFn: async (): Promise<${op.responseType}> => {
      const response = await fetch(\`${op.path}\`);
      if (!response.ok) throw new Error(\`${op.method} ${op.path} -> \${response.status}\`);
      return ${jsonResponseExpr(op)};
    },
  });
}`;
}

function tanstackMutation(op: ClientOp): string {
  const hookParams = op.params.map((p) => `${p}: string | number`).join(", ");
  const mutArg = op.requestType ? `body: ${op.requestType}` : "";
  const init = op.requestType
    ? `, {\n        method: "${op.method}",\n        headers: { "Content-Type": "application/json" },\n        body: JSON.stringify(${requestBodyExpr(op)}),\n      }`
    : `, { method: "${op.method}" }`;
  const ret =
    op.responseType === "void" ? "" : `\n      return ${jsonResponseExpr(op)};`;
  return `export function use${cap(op.fnName)}(${hookParams}) {
  return useMutation({
    mutationFn: async (${mutArg}): Promise<${op.responseType}> => {
      const response = await fetch(\`${op.path}\`${init});
      if (!response.ok) throw new Error(\`${op.method} ${op.path} -> \${response.status}\`);${ret}
    },
  });
}`;
}

function tanstackHook(op: ClientOp): string {
  return op.method === "GET" ? tanstackQuery(op) : tanstackMutation(op);
}

/** Import only the hooks the file actually declares — a query-only object omits useMutation and vice-versa — so the generated client compiles under the frontend app's noUnusedLocals. */
function tanstackPrelude(rows: RouteRow[]): string {
  const hooks = [];
  if (rows.some((row) => row.method !== "GET")) hooks.push("useMutation");
  if (rows.some((row) => row.method === "GET")) hooks.push("useQuery");
  return `import { ${hooks.join(", ")} } from "@tanstack/react-query";\n`;
}

const RENDERERS: Record<string, ClientRenderer> = {
  fetch: { render: fetchFn, prelude: () => "" },
  axios: { render: axiosFn, prelude: () => `import axios from "axios";\n` },
  tanstack: { render: tanstackHook, prelude: tanstackPrelude },
};

/** Render one client library file for a set of route rows: the library prelude (axios/tanstack imports), the `import type` header for every referenced frontend type, then one function/hook per operation. Pure — `ctx` carries `{ names, importable, components, typesImport, validatorsImport }` so request/response schemas resolve to imported read types (via the layout-resolved `typesImport` barrel specifier) or inlined structural types. */
export function renderClientFile(
  client: string,
  rows: RouteRow[],
  ctx: ClientCtx,
): string {
  const fileCtx: FileCtx = {
    ...ctx,
    imports: new Set<string>(),
    validatorValues: new Set<string>(),
    validatorTypes: new Set<string>(),
    needsZod: new Set<string>(),
  };
  const rendered = rows.map((row) =>
    RENDERERS[client].render(operationModel(row, fileCtx)),
  );
  const head = [
    RENDERERS[client].prelude(rows),
    validatorHeader(fileCtx, ctx.validatorsImport),
    importHeader(fileCtx.imports, ctx.typesImport),
  ]
    .filter(Boolean)
    .join("");
  return `${head}${head ? "\n" : ""}${rendered.join("\n\n")}\n`;
}

/** The single settings.frontend.generate_validators flag both generates each object's colocated validators.ts and drives whether clients wrap requests/responses in `Schema.parse()` — so the client always has the schema it imports. */
function resolveValidate(settings: ParsedSettings): boolean {
  return (
    (settings as { frontend?: { generateValidators?: boolean } })?.frontend
      ?.generateValidators === true
  );
}

/** The type names frontend_types actually generates (read entities/views, not write-body DTOs) — the exact set the client may `import type` from the barrel, derived the same way frontend_types derives its output. */
function importableTypeNames(
  viewData: unknown,
  datasourceData: unknown,
  names: CodegenNames,
): Set<string> {
  const components = buildComponents(
    viewData as RawTypesDoc,
    datasourceData as RawTypesDoc,
  );
  return new Set(
    Object.keys(components)
      .filter((name) => !isWriteDtoViewName(name))
      .map((name) => names.className(name)),
  );
}

/** One CONTENT file per (object, client), placed by layout mode via `frontendClientFile` (flat `clients/<object>.<lib>.ts`, by-feature `features/<object>/<lib>.ts`). Read-type + validators imports resolve through the layout so they track the file's placement. */
function clientFileEntries(
  ds: { name: string; clients: string[] },
  ctx: BaseCtx,
  rows: RouteRow[],
) {
  const entries = [];
  for (const [entity, entityRows] of groupRowsByEntity(rows)) {
    const fileCtx = {
      ...ctx,
      typesImport: ctx.layout.frontendTypesImport(ds.name),
    };
    const validatorFile = ctx.layout.frontendValidatorFile(ds.name, entity);
    for (const client of ds.clients) {
      const clientFile = ctx.layout.frontendClientFile(
        ds.name,
        entity,
        `${client}.ts`,
      );
      entries.push({
        kind: CONTENT,
        filename: clientFile,
        contents: renderClientFile(client, entityRows, {
          ...fileCtx,
          validatorsImport: ctx.layout.frontendRelImport(
            clientFile,
            validatorFile,
          ),
        }),
      });
    }
  }
  return entries;
}

/** A single add-if-absent deep-merge patch onto frontend/package.json carrying the npm deps every selected client needs (axios / @tanstack/react-query); null when only `fetch` (native) was requested, so no empty patch ships. */
function dependencyPatch(clients: Iterable<string>) {
  const dependencies: Record<string, string> = {};
  for (const client of clients)
    Object.assign(dependencies, CLIENT_DEPS[client]);
  if (Object.keys(dependencies).length === 0) return null;
  return {
    kind: PATCH,
    filename: join("frontend", "package.json"),
    content: JSON.stringify({ dependencies }),
  };
}

/** One datasource's client files: resolve its OpenAPI doc, render every (object, client) file, and record which client libraries it used (for the dependency patch). Skips a datasource with no requested clients. */
async function datasourceEntries(entry: unknown, base: GenerateBase) {
  const ds = bindingDatasource(entry);
  const clients = ds.clients.filter((c: string) => CLIENT_LIBS.has(c));
  if (clients.length === 0) return { entries: [], clients: [] };
  const { rows, components } = await resolveSelfDoc({
    schema: ds.schema,
    inputs: base.inputs,
    settings: base.settings,
  });
  const ctx: BaseCtx = {
    names: base.names,
    layout: base.layout,
    importable: base.importable,
    components,
    validate: base.validate,
    datetime: base.datetime,
  };
  return {
    entries: clientFileEntries({ ...ds, clients }, ctx, rows),
    clients,
  };
}

/** The read-only ctx every datasource's client files share: resolved names/layout/validate/datetime plus the set of type names frontend_types actually generates (so a `$ref` to one imports rather than inlines). */
async function buildBaseCtx(
  inputs: GenerateInputs,
  settings: ResolvedSettings,
): Promise<GenerateBase> {
  const names = namesForSettings(settings, "typescript");
  const { viewYamlText, datasourceYamlText } = await inputs.all();
  const importable = importableTypeNames(
    parse(viewYamlText),
    datasourceYamlText
      ? parseDatasourceTypes(datasourceYamlText, settings)
      : { types: [] },
    names,
  );
  return {
    names,
    layout: layoutForSettings(settings, "typescript"),
    importable,
    validate: resolveValidate(settings),
    inputs,
    settings,
    datetime: datetimeOptionFromSettings(settings).datetime,
  };
}

/** Generate typed client libraries for each datasource in frontend_bindings.yaml that declares a `clients` array. For `schema: self`, the datasource's OpenAPI doc is built in-process from this project's own routes/view/datasource (identical to the openapi_docs step), then projected to route rows grouped by object; each requested library (`fetch`/`axios`/`tanstack`) renders one file per object, placed by layout mode via `CodegenLayout.frontendClientFile` and importing the entity/view read types through the layout's resolved specifier. A `package.json` patch adds the npm dependency each selected client needs. `id:`/`url:`/`file:` schemas are not resolved yet and throw. */
export async function generate({
  inputs,
  settings,
}: {
  inputs: GenerateInputs;
  settings: ResolvedSettings;
}) {
  const { datasources } = await readBindings(inputs);
  if (datasources.length === 0) return { entries: [] };
  const base = await buildBaseCtx(inputs, settings);
  const entries = [];
  const clientsUsed = new Set<string>();
  for (const entry of datasources) {
    const built = await datasourceEntries(entry, base);
    entries.push(...built.entries);
    for (const client of built.clients) clientsUsed.add(client);
  }
  const patch = dependencyPatch(clientsUsed);
  if (patch) entries.push(patch);
  return { entries };
}

export const entriesNative = true;

export const assembleAfterStep = true;
