import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { datasourceTypeAncestry } from "@deterministic-code/generators-common/datasource-type-tree";
import pluralize from "pluralize";
import { toNative } from "./base-type-converter.ts";
import {
  datasourceTypesOf,
  isPkField,
  isReadonlyLookup,
  pkName,
  SERVICES_YAML,
  tableByName,
  viewTypesOf,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type DatasourceTable,
  type IDeterministic,
  type SeedRow,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { fieldSize, refParent } from "./common/view-shape.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { genericTmpl } from "./resources/service-integration-tests.ts";
import { createCasing } from "./common/default-casing.ts";
import {
  fakeTestData,
  fieldExpr,
  preludeSource,
  withFakerPackagePatch,
} from "./common/fake-test-data.ts";
import { bag, Emit } from "./emit.ts";

const SYSTEM_COLUMNS = new Set(["id", "uuid", "created", "updated"]);
const SNAKE_STEM = /^[a-z_][a-z0-9_]*$/;

/** Same physical-name rule as SQL `SqlMapping.tableName` — tests must hit the migrated table. */
const physicalTableName = (
  name: string,
  mapping: string | undefined,
  pluralizeFlag: boolean,
): string => {
  if (mapping !== undefined && !SNAKE_STEM.test(mapping)) return mapping;
  const stem = mapping ?? name;
  return pluralizeFlag
    ? stem.replace(/[^_]+$/, (token) => pluralize(token))
    : stem;
};

const hasStampColumns = (table: Type): boolean => {
  const names = new Set(table.fields.map((f) => f.name));
  return names.has("created") && names.has("updated");
};

const hasUuidColumn = (table: Type): boolean =>
  table.fields.some((f) => f.name === "uuid");

const hasFieldMappings = (overlay?: DatasourceTable): boolean =>
  (overlay?.fields ?? []).some((f) => f.mapping !== undefined);

const mutateViewName = (
  name: string,
  viewNames: ReadonlySet<string>,
): string | undefined => {
  if (viewNames.has(`create_${name}`)) return `create_${name}`;
  if (viewNames.has(`update_${name}`)) return `update_${name}`;
  return undefined;
};

const writableScalars = (
  table: Type,
  overlay?: DatasourceTable,
): TypeField[] => {
  const pk = pkName(table, overlay);
  return table.fields.filter(
    (field) =>
      !SYSTEM_COLUMNS.has(field.name) &&
      field.name !== pk &&
      !isPkField(field, table, overlay) &&
      field.references === undefined &&
      !field.isNullable &&
      field.hasDefault !== true,
  );
};

class Generator extends Emit {
  private readonly pluralizeTableNames: boolean;

  constructor(raw: Record<string, string>) {
    super(raw);
    this.pluralizeTableNames =
      String(raw["datasource.pluralize_datatable_names"]) !== "false";
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    const datasources = datasourceTypesOf(deterministic);
    const byName = new Map(datasources.map((t) => [t.name, t]));
    const overlays = tableByName(deterministic);
    const typeNames = new Set(byName.keys());
    const viewNames = new Set(viewTypesOf(deterministic).map((v) => v.name));
    const mode = this.settings.libraryReferenceMode;
    const entries = deterministic.services.generics.flatMap((c) => {
      const table = byName.get(c.name);
      if (table === undefined) return [];
      if (hasFieldMappings(overlays.get(c.name))) return [];
      return [
        this.test(
          c.name,
          table,
          byName,
          overlays,
          typeNames,
          viewNames,
          deterministic.datasourceSeeds,
          mode,
        ),
      ];
    });
    return withFakerPackagePatch(entries);
  }

  private typeRel(entity: string, viewNames: ReadonlySet<string>): string {
    return viewNames.has(entity)
      ? this.imports.viewRel(entity)
      : this.imports.datasourceRel(entity);
  }

  private typeImports(
    fromRel: string,
    entities: string[],
    viewNames: ReadonlySet<string>,
  ): { names: string; fromPath: string }[] {
    const byPath = new Map<string, string[]>();
    const add = (entity: string) => {
      const fromPath = this.imports.spec(
        fromRel,
        this.typeRel(entity, viewNames),
      );
      const typeName = this.casing.convertTypes(entity);
      const names = byPath.get(fromPath) ?? [];
      if (!names.includes(typeName)) names.push(typeName);
      byPath.set(fromPath, names);
    };
    for (const name of entities) {
      add(name);
      const mutate = mutateViewName(name, viewNames);
      if (mutate !== undefined) add(mutate);
    }
    return [...byPath.entries()]
      .map(([fromPath, names]) => ({
        fromPath,
        names: names.sort().join(", "),
      }))
      .sort((a, b) => a.fromPath.localeCompare(b.fromPath));
  }

  private pkEntry(node: Type, overlay?: DatasourceTable) {
    const column = pkName(node, overlay);
    const col = node.fields.find((f) => f.name === column);
    return {
      entityNameJson: JSON.stringify(node.name),
      columnJson: JSON.stringify(column),
      pkIdTypeJson: JSON.stringify(col?.type === "uuid" ? "uuid" : "integer"),
      isUuidPk: col?.type === "uuid",
    };
  }

  private test(
    entity: string,
    table: Type,
    byName: Map<string, Type>,
    overlays: Map<string, DatasourceTable>,
    typeNames: ReadonlySet<string>,
    viewNames: ReadonlySet<string>,
    seeds: Map<string, SeedRow[]>,
    mode: string | undefined,
  ): GenerateEntry {
    const overlay = overlays.get(table.name);
    const pkField =
      table.fields.find((f) => isPkField(f, table, overlay)) ??
      table.fields.find((f) => f.name === "id");
    const path = this.imports.serviceIntegrationTest(entity);
    const isUuidPk = pkField?.type === "uuid";
    const withUuid = hasUuidColumn(table);
    const stamps = hasStampColumns(table);
    const className = this.casing.serviceClassName(entity);
    const datasources = [...byName.values()];
    const chainNames = [
      ...datasourceTypeAncestry(datasources, entity),
      entity,
    ];
    const chainSupportsStamps = chainNames.every((name) => {
      const node = byName.get(name);
      return node !== undefined && (isReadonlyLookup(node) || hasStampColumns(node));
    });
    const missingLookup = chainNames.find((name) => {
      const node = byName.get(name);
      if (node === undefined || !isReadonlyLookup(node)) return false;
      return (seeds.get(name) ?? []).length === 0;
    });
    const isLookup = isReadonlyLookup(table);
    const hierarchy =
      missingLookup === undefined &&
      !isLookup &&
      stamps &&
      chainSupportsStamps
        ? this.hierarchyTokens(
            entity,
            chainNames,
            byName,
            overlays,
            typeNames,
            viewNames,
            seeds,
          )
        : false;
    const mutate = mutateViewName(entity, viewNames);
    return content(
      path,
      fill(genericTmpl, {
        prelude: hierarchy ? preludeSource(fakeTestData) : "",
        repositoriesImport: libraryImportSpecifier(
          "repositories",
          mode,
          this.imports.serviceIntegrationTestRel(entity),
        ),
        className,
        parentImports: hierarchy === false ? [] : hierarchy.parentImports,
        typeImports: this.typeImports(
          this.imports.serviceIntegrationTestRel(entity),
          chainNames,
          viewNames,
        ),
        serviceImport: this.imports.spec(
          this.imports.serviceIntegrationTestRel(entity),
          this.imports.serviceRel(entity),
        ),
        rowTypeName: this.casing.convertTypes(entity),
        createTypeName:
          mutate === undefined ? false : this.casing.convertTypes(mutate),
        tableNameJson: JSON.stringify(
          physicalTableName(entity, overlay?.mapping, this.pluralizeTableNames),
        ),
        pkEntries: chainNames.flatMap((name) => {
          const node = byName.get(name);
          return node === undefined
            ? []
            : [this.pkEntry(node, overlays.get(name))];
        }),
        entityNameJson: JSON.stringify(entity),
        entityName: entity,
        idTsType: toNative(pkField?.type ?? "integer"),
        withUuid,
        isUuidPk,
        stampCols: withUuid ? "id/uuid/created/updated" : "id/created/updated",
        missingId: isUuidPk
          ? JSON.stringify("00000000-0000-0000-0000-000000000000")
          : "99999",
        canCreate:
          hierarchy === false &&
          !isLookup &&
          missingLookup === undefined &&
          stamps,
        canUpdate: stamps,
        hierarchy,
        missingLookupSeed:
          missingLookup === undefined
            ? false
            : { lookupName: missingLookup },
      }),
      bag({
        module: this.imports.serviceIntegrationTestRel(entity),
        imports: this.imports.serviceRel(entity),
        uses: className,
      }),
    );
  }

  private hierarchyTokens(
    entity: string,
    chainNames: string[],
    byName: Map<string, Type>,
    overlays: Map<string, DatasourceTable>,
    typeNames: ReadonlySet<string>,
    viewNames: ReadonlySet<string>,
    seeds: Map<string, SeedRow[]>,
  ) {
    const parents = chainNames.filter((name) => name !== entity);
    const parentImports = parents.map((name) => ({
      className: this.casing.serviceClassName(name),
      importPath: this.imports.spec(
        this.imports.serviceIntegrationTestRel(entity),
        this.imports.serviceRel(name),
      ),
    }));
    const chainServices = parents.map((name) => {
      const node = byName.get(name)!;
      const pk = this.pkEntry(node, overlays.get(name));
      const className = this.casing.serviceClassName(name);
      return {
        varName: serviceVarName(className),
        className,
        rowTypeName: this.casing.convertTypes(name),
        tableNameJson: JSON.stringify(
          physicalTableName(
            name,
            overlays.get(name)?.mapping,
            this.pluralizeTableNames,
          ),
        ),
        entityNameJson: JSON.stringify(name),
        withUuid: hasUuidColumn(node),
        isUuidPk: pk.isUuidPk,
      };
    });
    const creates = chainNames.map((name) => {
      const node = byName.get(name)!;
      const isSubject = name === entity;
      const className = this.casing.serviceClassName(name);
      const lookup = isReadonlyLookup(node);
      const seed = (seeds.get(name) ?? [])[0];
      const mutate = mutateViewName(name, viewNames);
      return {
        isLookup: lookup,
        varName: isSubject ? "row" : this.casing.convertFields(name),
        serviceVar: isSubject ? "service" : serviceVarName(className),
        seedId: seed?.id ?? 1,
        missingSeedErrorJson: JSON.stringify(`expected seeded ${name}`),
        createTypeName:
          mutate === undefined ? false : this.casing.convertTypes(mutate),
        fields: this.payloadFields(node, typeNames, byName, overlays),
      };
    });
    const writable = chainNames.filter((name) => {
      const node = byName.get(name);
      return node !== undefined && !isReadonlyLookup(node);
    });
    const updates = [...writable].reverse().map((name) => {
      const node = byName.get(name)!;
      const isSubject = name === entity;
      const className = this.casing.serviceClassName(name);
      const fieldVar = isSubject ? "row" : this.casing.convertFields(name);
      return {
        serviceVar: isSubject ? "service" : serviceVarName(className),
        varName: fieldVar,
        updatedVarName: `${fieldVar}Updated`,
        pkIdent: this.casing.fieldIdent(pkName(node, overlays.get(name))),
        fields: this.scalarFields(node, overlays.get(name)),
      };
    });
    const deletes = [...writable].reverse().map((name) => {
      const node = byName.get(name)!;
      const isSubject = name === entity;
      const className = this.casing.serviceClassName(name);
      return {
        serviceVar: isSubject ? "service" : serviceVarName(className),
        varName: isSubject ? "row" : this.casing.convertFields(name),
        pkIdent: this.casing.fieldIdent(pkName(node, overlays.get(name))),
      };
    });
    return { parentImports, chainServices, creates, updates, deletes };
  }

  private scalarFields(
    table: Type,
    overlay?: DatasourceTable,
  ): { ident: string; expr: string }[] {
    return writableScalars(table, overlay).map((field) => ({
      ident: this.casing.fieldIdent(field.name),
      expr: fieldExpr(fakeTestData, field.type, {
        nativeType: toNative(field.type),
        size: fieldSize(field),
      }),
    }));
  }

  private payloadFields(
    table: Type,
    typeNames: ReadonlySet<string>,
    byName: Map<string, Type>,
    overlays: Map<string, DatasourceTable>,
  ): { ident: string; expr: string }[] {
    const fks = table.fields.flatMap((field) => {
      const parentName = refParent(field);
      if (parentName === undefined || !typeNames.has(parentName)) return [];
      const parent = byName.get(parentName)!;
      const pkIdent = this.casing.fieldIdent(
        pkName(parent, overlays.get(parentName)),
      );
      return [
        {
          ident: this.casing.fieldIdent(field.name),
          expr: `${this.casing.convertFields(parentName)}.${pkIdent}`,
        },
      ];
    });
    return [...fks, ...this.scalarFields(table)];
  }
}

const serviceVarName = (className: string): string => {
  const lowered = `${className.slice(0, 1).toLowerCase()}${className.slice(1)}`;
  return lowered === className ? `${className}_instance` : lowered;
};

/** Returns attributed entries. Cross-lane service imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(SERVICES_YAML);
  const casing = createCasing(ctx.settings);
  return new Generator(ctx.settings).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings, {
      serviceClassName: (entity) => casing.serviceClassName(entity),
    }),
  );
};
