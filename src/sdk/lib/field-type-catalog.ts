import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { packagedSpecPath } from "./packaged-spec-path.ts";
import { CONVERTER_MODULES } from "./field-converter.ts";
import { fieldTypeMappingRows } from "./generate-field-type-mappings.ts";

/** One builtin field-type as authored in the spec's `backend/types.yaml` (before its 1-based `id`/`sort_order` is joined on). `default_value` is the type's `implicit_default` rendered to its string form. */
interface FieldTypeSeed {
  name: string;
  supports_size: boolean;
  default_value: string | null;
  min_value?: string | null;
  max_value?: string | null;
  sort_order: number;
}

/** A `field_type` row carrying its 1-based catalog id so validators/mappings can join by `field_type_id`. */
interface FieldType extends FieldTypeSeed {
  id: number;
}

/** One `field_type_validator` seed row — an allowed default-value token and the regex that accepts it. */
interface FieldTypeValidator {
  field_type_id: number;
  token: string;
  regex: string;
  description: string | null;
}

/** One `field_type_mapping` seed row — a per-language or per-dialect target type (plus its optional runtime/rust converter) for a field type. */
interface FieldTypeMapping {
  field_type_id: number;
  target_kind: "language" | "dialect";
  target: string;
  target_type: string;
  constraints: string | null;
  converter: string | null;
  rust_converter: string | null;
}

/** One `field_type_converter` seed row — a registered generate-time converter module for a target. */
interface FieldTypeConverter {
  name: string;
  kind: string;
  target_kind: "language" | "dialect";
  target: string;
  source_url: string;
  entry: string | null;
  description: string | null;
}

/** The parsed catalog: every seed row as a plain record, `types` joinable to validators/mappings by `field_type_id`. */
interface FieldTypeCatalog {
  types: FieldType[];
  validators: FieldTypeValidator[];
  mappings: FieldTypeMapping[];
  converters: FieldTypeConverter[];
}

interface NumericBounds {
  min: bigint | null;
  max: bigint | null;
}

interface DefaultTokenRule {
  token: string;
  regex: string;
  description: string | null;
}

interface SchemaFieldDef {
  properties?: { type?: { const?: string } };
}

interface DatasourceTypesSchema {
  $defs: Record<string, SchemaFieldDef> & {
    fieldDef: { oneOf: Array<{ $ref: string }> };
  };
}

const SCHEMA_PATH = packagedSpecPath("backend/datasource-types.spec.yaml");
const TYPES_PATH = packagedSpecPath("backend/types.yaml");

interface TypesYamlType {
  supports_size: boolean;
  implicit_default: string | number | boolean | null;
  min_value: string | null;
  max_value: string | null;
  defaults: Array<Record<string, { regex: string; description: string }>>;
}

interface TypesYamlDoc {
  types: Array<Record<string, TypesYamlType>>;
}

const CONVERTER_DISPLAY: Record<string, string> = {
  typescript: "TypeScript",
  rust: "Rust",
  csharp: "C#",
  sqlite: "SQLite",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  oracle: "Oracle",
  sqlserver: "SQL Server",
};

/** Read the spec's language-agnostic builtin catalog (`backend/types.yaml`) into `{ types, validators }`. `id`/`sort_order` are the 1-based document order; `default_value` is the `implicit_default` in string form; each type's `defaults` become `field_type_id`-joined validator rows. */
async function readBuiltinTypes(
  typesPath: string,
): Promise<{ types: FieldType[]; validators: FieldTypeValidator[] }> {
  const doc: TypesYamlDoc = parse(await readFile(typesPath, "utf8"));
  const types: FieldType[] = [];
  const validators: FieldTypeValidator[] = [];
  doc.types.forEach((entry, index) => {
    const [name, def] = Object.entries(entry)[0];
    const id = index + 1;
    types.push({
      id,
      name,
      supports_size: def.supports_size,
      default_value:
        def.implicit_default === null ? null : String(def.implicit_default),
      min_value: def.min_value,
      max_value: def.max_value,
      sort_order: id,
    });
    for (const rule of def.defaults) {
      const [token, body] = Object.entries(rule)[0];
      validators.push({
        field_type_id: id,
        token,
        regex: body.regex,
        description: body.description,
      });
    }
  });
  return { types, validators };
}

/** The generate-time converter registry, projected from the field-converter modules — the dialect-specific catalog that lives outside the language-agnostic `types.yaml`. */
function deriveConverters(): FieldTypeConverter[] {
  return Object.values(CONVERTER_MODULES).map((mod) => {
    const isLanguage = mod.targetKind === "language";
    return {
      name: `${mod.target}${isLanguage ? "FieldConverter" : "SqlConverter"}`,
      kind: "generate",
      target_kind: mod.targetKind,
      target: mod.target,
      source_url: `https://github.com/rmcfadden/deterministic/blob/main/scripts/lib/field-converters/${mod.target}.ts`,
      entry: "default",
      description: `${CONVERTER_DISPLAY[mod.target]} ${isLanguage ? "native type" : "column type"} + default-expression converter`,
    };
  });
}

/** The authoritative set of field-type names, owned by `datasource-types.spec.yaml` `$defs` — every `*Field` def's `type.const`, plus the internal `reference` FK type (modelled as the typeless `referenceField`). */
async function schemaTypeNames(schemaPath: string): Promise<Set<string>> {
  const schema: DatasourceTypesSchema = parse(
    await readFile(schemaPath, "utf8"),
  );
  const names = new Set<string>(["reference"]);
  for (const [key, def] of Object.entries<SchemaFieldDef>(schema.$defs)) {
    if (!key.endsWith("Field")) continue;
    const konst = def.properties?.type?.const;
    if (typeof konst === "string") names.add(konst);
  }
  return names;
}

/** The authorable field-type names in `datasource-types.spec.yaml` `$defs.fieldDef.oneOf` declaration order, excluding the typeless `referenceField` FK — the ordered source the generated frontend `ALL_FIELD_TYPES` derives from. */
export async function schemaFieldTypeNames(
  schemaPath = SCHEMA_PATH,
): Promise<string[]> {
  const schema: DatasourceTypesSchema = parse(
    await readFile(schemaPath, "utf8"),
  );
  const names: string[] = [];
  for (const { $ref } of schema.$defs.fieldDef.oneOf) {
    const key = $ref.replace("#/$defs/", "");
    if (key === "referenceField") continue;
    const konst = schema.$defs[key]?.properties?.type?.const;
    if (typeof konst !== "string") {
      throw new Error(`invariant: schema $defs/${key} has no type const`);
    }
    names.push(konst);
  }
  return names;
}

async function assertTypesMatchSchema(
  catalog: FieldTypeCatalog,
  schemaPath: string,
): Promise<void> {
  const schema = await schemaTypeNames(schemaPath);
  const local = new Set(catalog.types.map((t) => t.name));
  const missingLocally = [...schema].filter((n) => !local.has(n));
  const absentFromSchema = [...local].filter((n) => !schema.has(n));
  if (missingLocally.length + absentFromSchema.length > 0) {
    throw new Error(
      `field-type catalog drift vs datasource-types.spec.yaml $defs — ` +
        `schema types with no local metadata: [${missingLocally.join(", ")}]; ` +
        `local types absent from schema: [${absentFromSchema.join(", ")}]`,
    );
  }
}

/** Build the field-type catalog: builtin `types` + `validators` from the spec's language-agnostic `backend/types.yaml`, `mappings` projected from the field-converter modules, `converters` from the converter registry. The type set is asserted against `datasource-types.spec.yaml` `$defs` so the two spec documents can never silently diverge. */
export async function loadFieldTypeCatalog(
  typesPath = TYPES_PATH,
  schemaPath = SCHEMA_PATH,
): Promise<FieldTypeCatalog> {
  const { types, validators } = await readBuiltinTypes(typesPath);
  const catalog: FieldTypeCatalog = {
    types,
    validators,
    mappings: fieldTypeMappingRows(types) as unknown as FieldTypeMapping[],
    converters: deriveConverters(),
  };
  await assertTypesMatchSchema(catalog, schemaPath);
  return catalog;
}

/** Numeric range bounds (`{ min, max }` as BigInt, or null when unbounded) for a type name — the semantic validator's authority for smallinteger/integer/biginteger. */
export function numericBoundsByTypeName(
  catalog: FieldTypeCatalog,
): Map<string, NumericBounds> {
  const out = new Map<string, NumericBounds>();
  for (const t of catalog.types) {
    const min =
      t.min_value === null || t.min_value === undefined
        ? null
        : BigInt(t.min_value);
    const max =
      t.max_value === null || t.max_value === undefined
        ? null
        : BigInt(t.max_value);
    if (min !== null || max !== null) out.set(t.name, { min, max });
  }
  return out;
}

function typeNameById(catalog: FieldTypeCatalog): Map<number, string> {
  return new Map(catalog.types.map((t): [number, string] => [t.id, t.name]));
}

/** `Map<typeName, targetType>` for one target language — the data `createTypeMapper` builds its lookup from. */
export function languageTypeMap(
  catalog: FieldTypeCatalog,
  language: string,
): Map<string | undefined, string> {
  const byId = typeNameById(catalog);
  const out = new Map<string | undefined, string>();
  for (const m of catalog.mappings) {
    if (m.target_kind === "language" && m.target === language) {
      out.set(byId.get(m.field_type_id), m.target_type);
    }
  }
  return out;
}

/** Allowed default-value tokens (with their validating regex) grouped by type name — drives spec validation of `default_value`. */
export function validatorsByTypeName(
  catalog: FieldTypeCatalog,
): Map<string | undefined, DefaultTokenRule[]> {
  const byId = typeNameById(catalog);
  const out = new Map<string | undefined, DefaultTokenRule[]>();
  for (const v of catalog.validators) {
    const name = byId.get(v.field_type_id);
    if (!out.has(name)) out.set(name, []);
    out
      .get(name)!
      .push({ token: v.token, regex: v.regex, description: v.description });
  }
  return out;
}

/** The user-authorable field-type names (excludes the internal `reference` FK type), ordered by `sort_order`. */
export function selectableTypeNames(catalog: FieldTypeCatalog): string[] {
  return catalog.types
    .filter((t) => t.name !== "reference")
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((t) => t.name);
}
