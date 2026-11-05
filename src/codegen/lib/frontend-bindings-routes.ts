import type { ParsedSettings } from "../../sdk/read-settings.ts";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { CodegenLayout } from "../../sdk/codegen-layout.ts";
import { buildOpenApiDocFromInputs } from "../../sdk/codegen/lib/generate-openapi-docs-shared.ts";
import { layoutForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import {
  CONTENT,
  type GenerateEntry,
} from "../../sdk/codegen/lib/generate-result.ts";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  oneOf?: SchemaObject[];
}

interface MediaContainer {
  content?: Record<string, { schema?: SchemaObject } | undefined>;
}

interface Operation {
  operationId?: string;
  tags?: string[];
  responses?: Record<string, MediaContainer>;
  requestBody?: MediaContainer;
}

type PathItem = Partial<Record<HttpMethod, Operation>>;

interface OpenApiDoc {
  paths?: Record<string, PathItem>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface OperationRow {
  name?: string;
  method: string;
  path: string;
  entity: string;
  request?: SchemaObject;
  response?: SchemaObject;
}

interface BindingDatasource {
  name: string;
  schema: unknown;
  clients: string[];
}

interface BindingObject {
  ds: BindingDatasource;
  entity: string;
  entityRows: OperationRow[];
  components: Record<string, SchemaObject>;
}

interface BindingContext {
  inputs: unknown;
  settings: ParsedSettings;
}

type DocOptions = Parameters<typeof buildOpenApiDocFromInputs>[0];
type LayoutSettings = Parameters<typeof layoutForSettings>[0];

export function refName(ref: string): string {
  return ref.slice("#/components/schemas/".length);
}

function jsonSchemaOf(media?: MediaContainer): SchemaObject | undefined {
  return media?.content?.["application/json"]?.schema;
}

function successSchema(operation: Operation): SchemaObject | undefined {
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (/^2\d\d$/.test(status) && jsonSchemaOf(response)) {
      return jsonSchemaOf(response);
    }
  }
  return undefined;
}

/** The object/entity a route belongs to: the openapi doc's group tag (`toPathGroupTag`, e.g. `Contacts`) when present, else the path's own resource segment so grouping never depends on `groupByEntity` being on. Exported so the live client-binding generator derives an object's directory identically to the client generator. */
export function entityOf(operation: Operation, path: string): string {
  const tag = operation.tags?.[0];
  if (tag) return tag;
  const segments = path.split("/").filter((s) => s && !s.startsWith("{"));
  const head = segments[0] === "api" ? segments[1] : segments[0];
  return head ?? "api";
}

/** The focused projection of an in-process OpenAPI doc onto the per-operation fields the frontend generators need (verb, path, operationId, grouping entity, request/response body schema) — resolved once via resolveSelfDoc so client_bindings and frontend_validators group routes one way. */
function operationRows(doc: OpenApiDoc): OperationRow[] {
  const rows: OperationRow[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation) continue;
      rows.push({
        name: operation.operationId,
        method: method.toUpperCase(),
        path,
        entity: entityOf(operation, path),
        request: jsonSchemaOf(operation.requestBody),
        response: successSchema(operation),
      });
    }
  }
  return rows;
}

/** Every `#/components/schemas/*` name a schema node references directly (through properties, array items, one_of) — the immediate `$ref` edges, not their transitive closure (that's walked in `reachableComponents`). */
function collectRefs(
  node: SchemaObject | undefined,
  acc: Set<string>,
): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (node.$ref) {
    acc.add(refName(node.$ref));
    return acc;
  }
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((m) => collectRefs(m, acc));
  if (node.items) collectRefs(node.items, acc);
  if (node.properties) {
    Object.values(node.properties).forEach((p) => collectRefs(p, acc));
  }
  return acc;
}

/** The transitive set of component schemas an object's routes touch: seed from every operation's request + response body, then follow `$ref` edges through the component graph. This is exactly the set the object's `validators.ts` declares and its client `.parse()`s — consumed by `validatorObjectEntries` so the validators generator and its test generator derive membership one way. */
function reachableComponents(
  rows: OperationRow[],
  components: Record<string, SchemaObject>,
): Set<string> {
  const stack: string[] = [];
  for (const row of rows) {
    collectRefs(row.request, new Set<string>()).forEach((r) => stack.push(r));
    collectRefs(row.response, new Set<string>()).forEach((r) => stack.push(r));
  }
  const closure = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (closure.has(name) || !components[name]) continue;
    closure.add(name);
    collectRefs(components[name], new Set<string>()).forEach((ref) => {
      if (!closure.has(ref)) stack.push(ref);
    });
  }
  return closure;
}

/** Bucket route rows by their `entity` so an generator can render one file per object. Insertion order is preserved, so the generated file set is deterministic. */
export function groupRowsByEntity<T>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = (row as { entity?: string }).entity as string;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return groups;
}

/** Read `frontend_bindings.yaml`'s `datasources` array (empty when the file is absent — a bare scaffold generates nothing). */
export async function readBindings(
  inputs: unknown,
): Promise<{ datasources: unknown[] }> {
  const path = join((inputs as { dir: string }).dir, "frontend_bindings.yaml");
  const present = await access(path).then(
    () => true,
    () => false,
  );
  if (!present) return { datasources: [] };
  const doc = parse(await readFile(path, "utf8"));
  return {
    datasources: Array.isArray(doc?.datasources) ? doc.datasources : [],
  };
}

/** One datasource binding entry unwrapped to `{ name, schema, clients }` (clients is the raw declared array; the caller filters to what it supports). */
export function bindingDatasource(entry: unknown): BindingDatasource {
  const record = entry as Record<
    string,
    { schema?: unknown; clients?: unknown }
  >;
  const [name] = Object.keys(record);
  const def = record[name] ?? {};
  return {
    name,
    schema: def.schema,
    clients: Array.isArray(def.clients) ? def.clients : [],
  };
}

/** The per-object work-list the frontend datasource generators share (via `clientBindingTestEntries` / `validatorObjectEntries`): for each binding datasource, resolve its OpenAPI doc once and yield `{ ds, entity, entityRows, components }` per object (route-group). Generators derive placement from `ds.name`/`entity` through `CodegenLayout`, so the layout owns paths one way. */
async function bindingObjects({
  inputs,
  settings,
}: BindingContext): Promise<BindingObject[]> {
  const { datasources } = await readBindings(inputs);
  const objects: BindingObject[] = [];
  for (const entry of datasources) {
    const ds = bindingDatasource(entry);
    const { rows, components } = await resolveSelfDoc({
      schema: ds.schema,
      inputs,
      settings,
    });
    for (const [entity, entityRows] of groupRowsByEntity(rows)) {
      objects.push({ ds, entity, entityRows, components });
    }
  }
  return objects;
}

type ValidatorRender = (
  closure: Set<string>,
  components: Record<string, SchemaObject>,
  ctx: { ds: string; entity: string; layout: CodegenLayout },
) => string;

/** One CONTENT entry per binding object that has a non-empty reachable-component closure — the shape both `frontend_validators` (`validators.ts`) and its test generator (`validators.test.ts`) share. `test` picks the validators file vs its test via `CodegenLayout.frontendValidatorFile`, so placement stays mode-aware. `render(closure, components, { ds, entity, layout })` produces the body; objects whose routes touch no component are skipped. */
export async function validatorObjectEntries(
  { inputs, settings }: BindingContext,
  { test = false }: { test?: boolean },
  render: ValidatorRender,
): Promise<GenerateEntry[]> {
  const layout = layoutForSettings(settings as LayoutSettings, "typescript");
  const entries: GenerateEntry[] = [];
  for (const { ds, entity, entityRows, components } of await bindingObjects({
    inputs,
    settings,
  })) {
    const closure = reachableComponents(entityRows, components);
    if (closure.size === 0) continue;
    entries.push({
      kind: CONTENT,
      filename: layout.frontendValidatorFile(ds.name, entity, { test }),
      contents: render(closure, components, { ds: ds.name, entity, layout }),
    });
  }
  return entries;
}

interface ClientBindingTestArgs extends BindingContext {
  clientLibs: string[];
  entryFor: (
    object: BindingObject,
    clients: string[],
    layout: CodegenLayout,
  ) => GenerateEntry[];
  harness: () => GenerateEntry[];
}

/** The per-(object, client) test-generator loop shared by the mocked and live client-binding test generators: yield `entryFor(object, clients, layout)` for every binding object whose declared clients intersect `clientLibs`, then append the one-shot `harness()` entries when anything was generated. Keeps the two generators' bodies to just their client set, per-entity renderer, and harness. */
export async function clientBindingTestEntries({
  inputs,
  settings,
  clientLibs,
  entryFor,
  harness,
}: ClientBindingTestArgs): Promise<{ entries: GenerateEntry[] }> {
  const layout = layoutForSettings(settings as LayoutSettings, "typescript");
  const entries: GenerateEntry[] = [];
  for (const object of await bindingObjects({ inputs, settings })) {
    const clients = object.ds.clients.filter((c) => clientLibs.includes(c));
    if (clients.length === 0) continue;
    entries.push(...entryFor(object, clients, layout));
  }
  if (entries.length > 0) entries.push(...harness());
  return { entries };
}

/** Build the project's own OpenAPI doc in-process and project it to `{ rows, components }`. Only `schema: self` resolves today; `id:`/`url:`/`file:` throw. */
export async function resolveSelfDoc({
  schema,
  inputs,
  settings,
}: BindingContext & { schema: unknown }): Promise<{
  doc: OpenApiDoc;
  rows: OperationRow[];
  components: Record<string, SchemaObject>;
}> {
  if (schema !== "self") {
    throw new Error(
      `frontend bindings: schema "${schema}" not yet supported — only \`self\` (this project's own backend) resolves today`,
    );
  }
  const doc = (await buildOpenApiDocFromInputs({
    inputs,
    settings,
  } as DocOptions)) as unknown as OpenApiDoc;
  return {
    doc,
    rows: operationRows(doc),
    components: doc.components?.schemas ?? {},
  };
}
