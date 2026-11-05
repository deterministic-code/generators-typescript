interface DatasourceSettingsLike {
  rustIdType(): string;
  idType: string;
}

interface Pk {
  column: string;
  rustType: string;
  idType?: string;
}

interface Candidate {
  name: string;
}

interface InferPkOptions {
  withIdType?: boolean;
  customOnly?: boolean;
  datasourceSettings?: DatasourceSettingsLike;
}

type DsEntry = Record<string, { fields?: unknown[] }>;

interface DatasourceData {
  types?: DsEntry[];
}

/** The implicit `id` primary key inherits the project's id_type from DatasourceSettings — a uuid project's routes must parse `{id}` as a uuid, not an integer — falling back to integer only when no settings are supplied. */
function defaultPk(
  withIdType: boolean,
  datasourceSettings?: DatasourceSettingsLike,
): Pk {
  const rustType = datasourceSettings ? datasourceSettings.rustIdType() : "i64";
  return withIdType
    ? {
        column: "id",
        rustType,
        idType: datasourceSettings ? datasourceSettings.idType : "integer",
      }
    : { column: "id", rustType };
}

function idTypeFromFieldType(fieldType: string): string {
  if (fieldType === "string") return "string";
  if (fieldType === "uuid") return "uuid";
  return "integer";
}

/** The first non-`id` field flagged `primary_key: true`, as a `{column, rustType, idType?}` PK — or null when the entity carries no custom primary key. */
function customPkFromFields(fields: unknown[], withIdType: boolean): Pk | null {
  for (const f of fields) {
    if (!f || typeof f !== "object") continue;
    const entries = Object.entries(f as Record<string, unknown>);
    if (entries.length === 0) continue;
    const [fname, fdef] = entries[0];
    if (typeof fname !== "string" || fname === "id") continue;
    if (!fdef || typeof fdef !== "object") continue;
    const def = fdef as Record<string, unknown>;
    if (def.primary_key !== true) continue;
    const fieldType = typeof def.type === "string" ? def.type : "integer";
    const pk: Pk = {
      column: fname,
      rustType: fieldType === "number" ? "i64" : "String",
    };
    if (withIdType) pk.idType = idTypeFromFieldType(fieldType);
    return pk;
  }
  return null;
}

export function inferPkForCandidate(
  candidate: Candidate,
  datasourceData: unknown,
  {
    withIdType = false,
    customOnly = false,
    datasourceSettings,
  }: InferPkOptions = {},
): Pk | null {
  const fallback = (): Pk | null =>
    customOnly ? null : defaultPk(withIdType, datasourceSettings);
  const rawTypes = (datasourceData as DatasourceData | null | undefined)?.types;
  const types = Array.isArray(rawTypes) ? rawTypes : [];
  const entry = types.find((e) => Object.keys(e)[0] === candidate.name);
  if (!entry) return fallback();
  const def = Object.values(entry)[0];
  const fields = Array.isArray(def?.fields) ? def.fields : [];
  return customPkFromFields(fields, withIdType) ?? fallback();
}
