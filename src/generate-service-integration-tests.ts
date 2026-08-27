import {
  createDatasourceNaming,
  type IDatasourceNaming,
} from "@deterministic-code/generators-common/datasource-naming";
import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { datasourceTypeAncestry } from "@deterministic-code/generators-common/datasource-type-tree";
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

const hasStampColumns = (table: Type): boolean => {
  const names = new Set(table.fields.map((f) => f.name));
  return names.has("created") && names.has("updated");
};

const hasFieldMappings = (overlay?: DatasourceTable): boolean =>
  (overlay?.fields ?? []).some((f) => f.mapping !== undefined);

const writableScalars = (
  table: Type,
  overlay?: DatasourceTable,
): TypeField[] =>
  table.fields.filter(
    (field) =>
      !SYSTEM_COLUMNS.has(field.name) &&
      !isPkField(field, table, overlay) &&
      field.references === undefined &&
      !field.isNullable &&
      field.hasDefault !== true,
  );

const serviceVarName = (className: string): string => {
  const lowered = `${className.slice(0, 1).toLowerCase()}${className.slice(1)}`;
  return lowered === className ? `${className}_instance` : lowered;
};

class Generator extends Emit {
  private readonly naming: IDatasourceNaming;
  private readonly datasources: Type[];
  private readonly byName: Map<string, Type>;
  private readonly overlays: Map<string, DatasourceTable>;
  private readonly viewNames: ReadonlySet<string>;
  private readonly seeds: Map<string, SeedRow[]>;
  private readonly spec: IDeterministic;

  constructor(raw: Record<string, string>, spec: IDeterministic) {
    super(raw);
    this.spec = spec;
    this.naming = createDatasourceNaming(raw);
    this.datasources = datasourceTypesOf(spec);
    this.byName = new Map(this.datasources.map((t) => [t.name, t]));
    this.overlays = tableByName(spec);
    this.viewNames = new Set(viewTypesOf(spec).map((v) => v.name));
    this.seeds = spec.datasourceSeeds;
  }

  from(): GenerateEntry[] {
    return withFakerPackagePatch(
      this.spec.services.generics.flatMap((c) => {
        const table = this.byName.get(c.name);
        if (table === undefined || hasFieldMappings(this.overlays.get(c.name))) {
          return [];
        }
        return [this.test(table)];
      }),
    );
  }

  private mutateView(name: string): string | undefined {
    if (this.viewNames.has(`create_${name}`)) return `create_${name}`;
    if (this.viewNames.has(`update_${name}`)) return `update_${name}`;
    return undefined;
  }

  private tableNameJson(name: string): string {
    return JSON.stringify(
      this.naming.resolveTable(name, this.overlays.get(name)?.mapping),
    );
  }

  private typeRel(entity: string): string {
    return this.viewNames.has(entity)
      ? this.imports.viewRel(entity)
      : this.imports.datasourceRel(entity);
  }

  private typeImports(
    fromRel: string,
    entities: string[],
  ): { names: string; fromPath: string }[] {
    const byPath = new Map<string, string[]>();
    const add = (entity: string) => {
      const fromPath = this.imports.spec(fromRel, this.typeRel(entity));
      const typeName = this.casing.convertTypes(entity);
      const names = byPath.get(fromPath) ?? [];
      if (!names.includes(typeName)) names.push(typeName);
      byPath.set(fromPath, names);
    };
    for (const name of entities) {
      add(name);
      const mutate = this.mutateView(name);
      if (mutate !== undefined) add(mutate);
    }
    return [...byPath.entries()]
      .map(([fromPath, names]) => ({
        fromPath,
        names: names.sort().join(", "),
      }))
      .sort((a, b) => a.fromPath.localeCompare(b.fromPath));
  }

  private pkEntry(node: Type) {
    const overlay = this.overlays.get(node.name);
    const column = pkName(node, overlay);
    const type = node.fields.find((f) => f.name === column)?.type ?? "integer";
    return {
      entityNameJson: JSON.stringify(node.name),
      columnJson: JSON.stringify(column),
      pkIdTypeJson: JSON.stringify(type === "uuid" ? "uuid" : "integer"),
      isUuidPk: type === "uuid",
      idTsType: toNative(type),
      pkIdent: this.casing.fieldIdent(column),
    };
  }

  private serviceRef(name: string, entity: string) {
    const isSubject = name === entity;
    const className = this.casing.serviceClassName(name);
    return {
      className,
      serviceVar: isSubject ? "service" : serviceVarName(className),
      varName: isSubject ? "row" : this.casing.convertFields(name),
    };
  }

  private test(table: Type): GenerateEntry {
    const entity = table.name;
    const pk = this.pkEntry(table);
    const path = this.imports.serviceIntegrationTest(entity);
    const stamps = hasStampColumns(table);
    const className = this.casing.serviceClassName(entity);
    const chainNames = [
      ...datasourceTypeAncestry(this.datasources, entity),
      entity,
    ];
    const missingLookup = chainNames.find((name) => {
      const node = this.byName.get(name);
      return (
        node !== undefined &&
        isReadonlyLookup(node) &&
        (this.seeds.get(name) ?? []).length === 0
      );
    });
    const isLookup = isReadonlyLookup(table);
    const chainSupportsStamps = chainNames.every((name) => {
      const node = this.byName.get(name);
      return (
        node !== undefined &&
        (isReadonlyLookup(node) || hasStampColumns(node))
      );
    });
    const hierarchy =
      missingLookup === undefined &&
      !isLookup &&
      stamps &&
      chainSupportsStamps
        ? this.hierarchyTokens(entity, chainNames)
        : false;
    const mutate = this.mutateView(entity);
    return content(
      path,
      fill(genericTmpl, {
        prelude: hierarchy ? preludeSource(fakeTestData) : "",
        repositoriesImport: libraryImportSpecifier(
          "repositories",
          this.settings.libraryReferenceMode,
          this.imports.serviceIntegrationTestRel(entity),
        ),
        className,
        parentImports: hierarchy === false ? [] : hierarchy.parentImports,
        typeImports: this.typeImports(
          this.imports.serviceIntegrationTestRel(entity),
          chainNames,
        ),
        serviceImport: this.imports.spec(
          this.imports.serviceIntegrationTestRel(entity),
          this.imports.serviceRel(entity),
        ),
        rowTypeName: this.casing.convertTypes(entity),
        createTypeName:
          mutate === undefined ? false : this.casing.convertTypes(mutate),
        tableNameJson: this.tableNameJson(entity),
        pkEntries: chainNames.flatMap((name) => {
          const node = this.byName.get(name);
          return node === undefined ? [] : [this.pkEntry(node)];
        }),
        entityNameJson: JSON.stringify(entity),
        entityName: entity,
        idTsType: pk.idTsType,
        isUuidPk: pk.isUuidPk,
        missingId: pk.isUuidPk
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

  private hierarchyTokens(entity: string, chainNames: string[]) {
    const parents = chainNames.filter((name) => name !== entity);
    const parentImports = parents.map((name) => ({
      className: this.casing.serviceClassName(name),
      importPath: this.imports.spec(
        this.imports.serviceIntegrationTestRel(entity),
        this.imports.serviceRel(name),
      ),
    }));
    const chainServices = parents.map((name) => {
      const ref = this.serviceRef(name, entity);
      return {
        varName: ref.serviceVar,
        className: ref.className,
        rowTypeName: this.casing.convertTypes(name),
        tableNameJson: this.tableNameJson(name),
        entityNameJson: JSON.stringify(name),
        isUuidPk: this.pkEntry(this.byName.get(name)!).isUuidPk,
      };
    });
    const creates = chainNames.map((name) => {
      const node = this.byName.get(name)!;
      const ref = this.serviceRef(name, entity);
      const mutate = this.mutateView(name);
      return {
        isLookup: isReadonlyLookup(node),
        varName: ref.varName,
        serviceVar: ref.serviceVar,
        seedId: (this.seeds.get(name) ?? [])[0]?.id ?? 1,
        missingSeedErrorJson: JSON.stringify(`expected seeded ${name}`),
        createTypeName:
          mutate === undefined ? false : this.casing.convertTypes(mutate),
        fields: this.payloadFields(node),
      };
    });
    const writable = chainNames.filter((name) => {
      const node = this.byName.get(name);
      return node !== undefined && !isReadonlyLookup(node);
    });
    const updates = [...writable].reverse().map((name) => {
      const node = this.byName.get(name)!;
      const ref = this.serviceRef(name, entity);
      return {
        serviceVar: ref.serviceVar,
        varName: ref.varName,
        updatedVarName: `${ref.varName}Updated`,
        pkIdent: this.pkEntry(node).pkIdent,
        fields: this.scalarFields(node),
      };
    });
    const deletes = [...writable].reverse().map((name) => {
      const node = this.byName.get(name)!;
      const ref = this.serviceRef(name, entity);
      return {
        serviceVar: ref.serviceVar,
        varName: ref.varName,
        pkIdent: this.pkEntry(node).pkIdent,
      };
    });
    return { parentImports, chainServices, creates, updates, deletes };
  }

  private scalarFields(table: Type): { ident: string; expr: string }[] {
    return writableScalars(table, this.overlays.get(table.name)).map(
      (field) => ({
        ident: this.casing.fieldIdent(field.name),
        expr: fieldExpr(fakeTestData, field.type, {
          nativeType: toNative(field.type),
          size: fieldSize(field),
        }),
      }),
    );
  }

  private payloadFields(table: Type): { ident: string; expr: string }[] {
    const fks = table.fields.flatMap((field) => {
      const parentName = refParent(field);
      if (parentName === undefined || !this.byName.has(parentName)) return [];
      const parent = this.byName.get(parentName)!;
      return [
        {
          ident: this.casing.fieldIdent(field.name),
          expr: `${this.casing.convertFields(parentName)}.${this.pkEntry(parent).pkIdent}`,
        },
      ];
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
  const spec = await DeterministicParser(ctx.reader).parse(ctx.settings, {
    serviceClassName: (entity) => casing.serviceClassName(entity),
  });
  return new Generator(ctx.settings, spec).from();
};
