interface DatasourceFieldDef {
  type: string;
  is_nullable?: boolean;
  default_value?: unknown;
  references?: unknown;
  [key: string]: unknown;
}

interface DatasourceTableDef {
  datasource_type?: string;
  fields: Array<Record<string, DatasourceFieldDef>>;
}

/** Unwrap a `{ table: { datasource_type, fields } }` entry into `{ name, datasourceType, fields }`. Each field carries the common `{ name, type, isNullable, defaultValue, references }`; `fieldExtras(fdef)` merges any dialect-specific props (e.g. csharp's `size`/`isUnique`). */
export function normalizeDatasourceTable(
  entry: unknown,
  fieldExtras: (fdef: DatasourceFieldDef) => Record<string, unknown> = (
    _fdef,
  ) => ({}),
) {
  const [name, def] = Object.entries(
    entry as Record<string, DatasourceTableDef>,
  )[0];
  return {
    name,
    datasourceType: def.datasource_type,
    fields: def.fields.map((f) => {
      const [fname, fdef] = Object.entries(f)[0];
      return {
        name: fname,
        type: fdef.type,
        isNullable: fdef.is_nullable === true,
        defaultValue: fdef.default_value,
        references: fdef.references,
        ...fieldExtras(fdef),
      };
    }),
  };
}
