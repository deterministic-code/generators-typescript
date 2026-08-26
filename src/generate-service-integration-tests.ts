import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import pluralize from "pluralize";
import { toNative } from "./base-type-converter.ts";
import {
  columnFields,
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
import { joinImport, libraryImportSpecifier } from "./library-import.ts";
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

/** Same last-token rule as SQL `effectiveTableName` — tests must hit the physical table. */
const physicalTableName = (name: string, pluralizeFlag: boolean): string =>
  pluralizeFlag && name
    ? name.replace(/[^_]+$/, (token) => pluralize(token))
    : name;

const findType = (
  name: string,
  types: Type[],
): Type | undefined => types.find((d) => d.name === name);

const isEligible = (table: Type | undefined): table is Type =>
  table !== undefined;

/** All in-set `references` parents, recursively, parent before child. Matches generators-common `datasourceTypeAncestry`. */
const referencedAncestry = (
  types: readonly Type[],
  name: string,
): string[] => {
  const typeNames = new Set(types.map((type) => type.name));
  const byName = new Map(types.map((type) => [type.name, type]));
  if (!byName.has(name)) return [];
  const parentsOf = (type: Type): string[] => {
    const parents: string[] = [];
    const seen = new Set<string>();
    for (const field of type.fields) {
      const parent = refParent(field);
      if (
        parent === undefined ||
        parent.length === 0 ||
        parent === type.name ||
        !typeNames.has(parent) ||
        seen.has(parent)
      ) {
        continue;
      }
      seen.add(parent);
      parents.push(parent);
    }
    return parents;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (current: string, path: ReadonlySet<string>): void => {
    const type = byName.get(current);
    if (type === undefined) return;
    for (const parent of parentsOf(type)) {
      if (path.has(parent) || seen.has(parent)) continue;
      walk(parent, new Set([...path, current]));
      if (seen.has(parent)) continue;
      seen.add(parent);
      out.push(parent);
    }
  };
  walk(name, new Set([name]));
  return out;
};

const serviceVarName = (className: string): string =>
  `${className.slice(0, 1).toLowerCase()}${className.slice(1)}`;

const pkColumn = (table: Type, overlay?: DatasourceTable): string =>
  pkName(table, overlay);

const writableScalars = (
  table: Type,
  overlay?: DatasourceTable,
): TypeField[] => {
  const pk = pkColumn(table, overlay);
  return columnFields(table.fields).filter(
    (field) =>
      !SYSTEM_COLUMNS.has(field.name) &&
      field.name !== pk &&
      !isPkField(field, table, overlay) &&
      field.references === undefined &&
      !field.isNullable &&
      field.hasDefault !== true,
  );
};

const fkFields = (
  table: Type,
  typeNames: ReadonlySet<string>,
): TypeField[] =>
  columnFields(table.fields).filter((field) => {
    const parent = refParent(field);
    return parent !== undefined && typeNames.has(parent);
  });

const mutateViewName = (
  name: string,
  viewNames: ReadonlySet<string>,
): string | undefined => {
  if (viewNames.has(`create_${name}`)) return `create_${name}`;
  if (viewNames.has(`update_${name}`)) return `update_${name}`;
  return undefined;
};

class Generator extends Emit {
  private readonly pluralizeTableNames: boolean;

  constructor(raw: Record<string, string>) {
    super(raw);
    this.pluralizeTableNames =
      String(raw["datasource.pluralize_datatable_names"]) !== "false";
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    const { generics } = deterministic.services;
    const datasources = datasourceTypesOf(deterministic);
    const overlays = tableByName(deterministic);
    const mode = this.settings.libraryReferenceMode;
    const typeNames = new Set(datasources.map((table) => table.name));
    const viewNames = new Set(viewTypesOf(deterministic).map((view) => view.name));
    const entries = generics.flatMap((c) => {
      const table = findType(c.name, datasources);
      if (!isEligible(table)) return [];
      return [
        this.test(
          c.name,
          table,
          datasources,
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
      const fromPath = this.imports.spec(fromRel, this.typeRel(entity, viewNames));
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

  private test(
    entity: string,
    table: Type,
    datasources: Type[],
    overlays: Map<string, DatasourceTable>,
    typeNames: ReadonlySet<string>,
    viewNames: ReadonlySet<string>,
    seeds: Map<string, SeedRow[]>,
    mode: string | undefined,
  ): GenerateEntry {
    const overlay = overlays.get(table.name);
    const pk =
      table.fields.find((f) => isPkField(f, table, overlay)) ??
      table.fields.find((f) => f.name === "id");
    const pkField = pk;
    const path = this.imports.serviceIntegrationTest(entity);
    const isUuid = pkField?.type === "uuid";
    const withUuid = table.fields.some((f) => f.name === "uuid");
    const className = this.casing.serviceClassName(entity);
    const chainNames = [...referencedAncestry(datasources, entity), entity];
    const missingLookup = chainNames.find((name) => {
      const node = findType(name, datasources);
      if (node === undefined || !isReadonlyLookup(node)) return false;
      return (seeds.get(name) ?? []).length === 0;
    });
    const isLookup = isReadonlyLookup(table);
    const hierarchy =
      missingLookup === undefined && !isLookup
        ? this.hierarchyTokens(
            entity,
            chainNames,
            datasources,
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
        serviceImport: joinImport("..", this.casing.fileBase(`${entity}_service`)),
        rowTypeName: this.casing.convertTypes(entity),
        createTypeName:
          mutate === undefined ? false : this.casing.convertTypes(mutate),
        tableNameJson: JSON.stringify(
          physicalTableName(entity, this.pluralizeTableNames),
        ),
        pkEntries: chainNames.flatMap((name) => {
          const node = findType(name, datasources);
          if (node === undefined) return [];
          const column = pkColumn(node, overlays.get(name));
          const col = node.fields.find((f) => f.name === column);
          return [
            {
              entityNameJson: JSON.stringify(name),
              columnJson: JSON.stringify(column),
              pkIdTypeJson: JSON.stringify(col?.type === "uuid" ? "uuid" : "integer"),
            },
          ];
        }),
        entityNameJson: JSON.stringify(entity),
        entityName: entity,
        pkIdTypeJson: JSON.stringify(isUuid ? "uuid" : "integer"),
        idTsType: toNative(pkField?.type ?? "integer"),
        withUuid,
        stampCols: withUuid
          ? "id/uuid/created/updated"
          : "id/created/updated",
        serviceOptions: isUuid ? `, { idType: "uuid" }` : "",
        missingId: isUuid
          ? JSON.stringify("00000000-0000-0000-0000-000000000000")
          : "99999",
        canCreate: hierarchy === false && !isLookup && missingLookup === undefined,
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
    datasources: Type[],
    overlays: Map<string, DatasourceTable>,
    typeNames: ReadonlySet<string>,
    viewNames: ReadonlySet<string>,
    seeds: Map<string, SeedRow[]>,
  ) {
    const parents = chainNames.filter((name) => name !== entity);
    const parentImports = parents.map((name) => ({
      className: this.casing.serviceClassName(name),
      importPath: this.imports.testSpec(
        this.imports.service(name),
        `${name}_service`,
      ),
    }));
    const chainServices = parents.map((name) => {
      const node = findType(name, datasources)!;
      const column = pkColumn(node, overlays.get(name));
      const col = node.fields.find((f) => f.name === column);
      const className = this.casing.serviceClassName(name);
      return {
        varName: serviceVarName(className),
        className,
        rowTypeName: this.casing.convertTypes(name),
        tableNameJson: JSON.stringify(
          physicalTableName(name, this.pluralizeTableNames),
        ),
        entityNameJson: JSON.stringify(name),
        serviceOptions: col?.type === "uuid" ? `, { idType: "uuid" }` : "",
      };
    });
    const creates = chainNames.map((name) => {
      const node = findType(name, datasources)!;
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
        fields: this.payloadFields(node, typeNames, datasources, overlays),
      };
    });
    const writable = chainNames.filter((name) => {
      const node = findType(name, datasources);
      return node !== undefined && !isReadonlyLookup(node);
    });
    const updates = [...writable].reverse().map((name) => {
      const node = findType(name, datasources)!;
      const isSubject = name === entity;
      const className = this.casing.serviceClassName(name);
      return {
        serviceVar: isSubject ? "service" : serviceVarName(className),
        varName: isSubject ? "row" : this.casing.convertFields(name),
        updatedVarName: `${isSubject ? "row" : this.casing.convertFields(name)}Updated`,
        pkIdent: this.casing.fieldIdent(pkColumn(node, overlays.get(name))),
        fields: this.scalarFields(node, overlays.get(name)),
      };
    });
    const deletes = [...writable].reverse().map((name) => {
      const node = findType(name, datasources)!;
      const isSubject = name === entity;
      const className = this.casing.serviceClassName(name);
      const column = pkColumn(node, overlays.get(name));
      return {
        serviceVar: isSubject ? "service" : serviceVarName(className),
        varName: isSubject ? "row" : this.casing.convertFields(name),
        pkIdent: this.casing.fieldIdent(column),
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
    datasources: Type[],
    overlays: Map<string, DatasourceTable>,
  ): { ident: string; expr: string }[] {
    const fks = fkFields(table, typeNames).map((field) => {
      const parentName = refParent(field)!;
      const parent = findType(parentName, datasources)!;
      const column = pkColumn(parent, overlays.get(parentName));
      const pkIdent = this.casing.fieldIdent(column);
      const parentVar = this.casing.convertFields(parentName);
      return {
        ident: this.casing.fieldIdent(field.name),
        expr: `${parentVar}.${pkIdent}`,
      };
    });
    return [...fks, ...this.scalarFields(table)];
  }
}

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
