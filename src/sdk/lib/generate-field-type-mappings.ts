import { CONVERTER_MODULES } from "./field-converter.ts";
import { catalogRowsFor } from "./field-converters/base.ts";

type MappingTarget = keyof typeof CONVERTER_MODULES;

/** One projected conversion row for a target — the shape `catalogRowsFor` yields from a converter module. */
interface CatalogRow {
  target_kind: string;
  target: string;
  type: string;
  target_type: string;
  constraints: string | null;
  converter: string | null;
  rust_converter: string | null;
}

interface FieldType {
  id: number;
  name: string;
}

interface MappingRow {
  id: number;
  field_type_id: number;
  target_kind: string;
  target: string;
  target_type: string;
  constraints: string | null;
  converter: string | null;
  rust_converter: string | null;
}

/** The order `field_type_mapping` seed rows are generated in per field type — three languages, then the five SQL dialects. */
export const MAPPING_TARGET_ORDER: MappingTarget[] = [
  "typescript",
  "rust",
  "csharp",
  "sqlite",
  "mysql",
  "postgres",
  "oracle",
  "sqlserver",
];

/** The full `field_type_mapping` seed rows projected from the per-target converter modules — one row per (field type × target), the single source the mappings catalog is generated from. `types` is the catalog's `field_type` list (`{ id, name }`). */
export function fieldTypeMappingRows(types: FieldType[]): MappingRow[] {
  const byType = new Map<MappingTarget, Map<string, CatalogRow>>(
    MAPPING_TARGET_ORDER.map((target) => [
      target,
      new Map(
        (catalogRowsFor(CONVERTER_MODULES[target]) as CatalogRow[]).map((r) => [
          r.type,
          r,
        ]),
      ),
    ]),
  );
  const rows: MappingRow[] = [];
  let id = 1;
  for (const t of [...types].sort((a, b) => a.id - b.id)) {
    for (const target of MAPPING_TARGET_ORDER) {
      const r = byType.get(target)!.get(t.name);
      if (!r) {
        throw new Error(`no ${target} conversion for field type "${t.name}"`);
      }
      rows.push({
        id: id++,
        field_type_id: t.id,
        target_kind: r.target_kind,
        target: r.target,
        target_type: r.target_type,
        constraints: r.constraints,
        converter: r.converter,
        rust_converter: r.rust_converter,
      });
    }
  }
  return rows;
}

function yamlScalar(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

/** The YAML text for the `field_type_mapping` `seeds:` list body (each `- idN:` entry), indented to match `datasource_types.yaml`. */
export function fieldTypeMappingSeedsYaml(types: FieldType[]): string {
  const lines: string[] = [];
  for (const r of fieldTypeMappingRows(types)) {
    lines.push(
      `        - id${r.id}:`,
      `            field_type_id: ${r.field_type_id}`,
      `            target_kind: ${yamlScalar(r.target_kind)}`,
      `            target: ${yamlScalar(r.target)}`,
      `            target_type: ${yamlScalar(r.target_type)}`,
      `            constraints: ${yamlScalar(r.constraints)}`,
      `            converter: ${yamlScalar(r.converter)}`,
      `            rust_converter: ${yamlScalar(r.rust_converter)}`,
    );
  }
  return lines.join("\n") + "\n";
}
