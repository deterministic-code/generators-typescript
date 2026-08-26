import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  authoredViewTypesOf,
  datasourceTypesOf,
  TYPES_YAML,
  typeHasTag,
  viewTypesOf,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  dictionariesForView,
  ownedDictionariesOf,
  type OwnedDictionary,
} from "./common/owned-dictionaries.ts";
import { fieldRefKind, fieldSize, isAlias } from "./common/view-shape.ts";
import { toZod } from "./common/type-converters/native-to-zod.ts";
import { bag, Emit } from "./emit.ts";
import {
  indexTmpl as defaultIndexTmpl,
  schemaInheritTmpl as defaultSchemaInheritTmpl,
  schemaStandaloneTmpl as defaultSchemaStandaloneTmpl,
  schemaUnionTmpl as defaultSchemaUnionTmpl,
  typeTmpl as defaultTypeTmpl,
} from "./resources/view-type-validators.ts";

export type ViewValidatorTemplates = {
  typeTmpl: string;
  indexTmpl: string;
  schemaUnionTmpl: string;
  schemaStandaloneTmpl: string;
  schemaInheritTmpl: string;
};

export type ViewValidatorEmitMode = {
  referenceBackendType?: boolean;
  templates?: ViewValidatorTemplates;
  basePath?: string;
  datasourceBasePath?: string;
};

const omitObj = (keys: string[]) =>
  keys.map((k) => `${JSON.stringify(k)}: true`).join(", ");

const WRITE_PREFIXES = ["update_", "create_"] as const;
const isWriteVariant = (name: string): boolean =>
  WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));

const BUILTIN_PARENTS = new Set(["set", "dictionary", "file"]);
const isBuiltinInherit = (view: Type): boolean =>
  view.inherits !== undefined && BUILTIN_PARENTS.has(view.inherits);

const tighten = (field: TypeField): string => {
  const base = toZod(field.base);
  const max = fieldSize(field);
  switch (field.base) {
    case "string":
    case "character": {
      let expr = `${base}.trim()`;
      if (field.minSize !== undefined && field.minSize >= 0) expr += `.min(${field.minSize})`;
      if (max !== undefined && max >= 0) expr += `.max(${max})`;
      return expr;
    }
    case "number":
    case "integer":
    case "biginteger":
    case "smallinteger":
    case "reference": {
      let expr = `${base}.int()`;
      if (field.name === "id" || field.name.endsWith("_id")) expr += ".nonnegative()";
      if (field.minSize !== undefined) expr += `.min(${field.minSize})`;
      if (max !== undefined) expr += `.max(${max})`;
      return expr;
    }
    default:
      return base;
  }
};

const indexExports = (
  view: Type,
  schemaName: (name: string) => string,
): string | undefined => {
  const schema = schemaName(view.name);
  if (isWriteVariant(view.name)) return schema;
  if ((view.removeFields?.length ?? 0) > 0) return undefined;
  if (view.inherits !== undefined) return schema;
  return [
    schema,
    schemaName(`create_${view.name}`),
    schemaName(`update_${view.name}`),
    schemaName(`patch_${view.name}`),
  ].join(", ");
};

class Generator extends Emit {
  private readonly referenceBackendType: boolean;
  private readonly templates: ViewValidatorTemplates;
  private parentFieldsByName = new Map<string, Set<string>>();
  private typesByName = new Map<string, Type>();
  private dictionaries: OwnedDictionary[] = [];

  constructor(raw: Record<string, string>, mode: ViewValidatorEmitMode) {
    super(raw, mode.basePath ?? ".", mode.datasourceBasePath ?? ".");
    this.referenceBackendType = mode.referenceBackendType ?? true;
    this.templates = mode.templates ?? {
      typeTmpl: defaultTypeTmpl,
      indexTmpl: defaultIndexTmpl,
      schemaUnionTmpl: defaultSchemaUnionTmpl,
      schemaStandaloneTmpl: defaultSchemaStandaloneTmpl,
      schemaInheritTmpl: defaultSchemaInheritTmpl,
    };
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    this.dictionaries = ownedDictionariesOf(deterministic.expandedTypes);
    this.parentFieldsByName = new Map(
      datasourceTypesOf(deterministic).map((table) => [
        table.name,
        new Set(table.fields.map((field) => field.name)),
      ]),
    );
    const expandedByName = new Map(
      viewTypesOf(deterministic).map((v) => [v.name, v]),
    );
    const views = authoredViewTypesOf(deterministic);
    const entries = views.map((view) => {
      const collected = this.collectImports(view, expandedByName.get(view.name));
      const schemaName = this.casing.schemaName(view.name);
      const validatedTypeName = this.casing.validatedTypeName(view.name);
      return content(
        this.imports.viewValidator(view.name),
        fill(this.templates.typeTmpl, {
          schemaVersion: this.settings.schemaVersion,
          imports: collected.imports,
          schemaBody: this.schemaBody(view, expandedByName.get(view.name)),
          withTypeAnnotation: true,
          className: this.casing.convertTypes(view.name),
          schemaName,
          validatedTypeName,
        }),
        bag({
          module: this.imports.viewValidatorRel(view.name),
          exports: this.fileExports(view, schemaName, validatedTypeName),
          imports: collected.importRels,
          uses: collected.useNames,
        }),
      );
    });
    const index = this.imports.index(
      this.imports.viewValidator(views[0]?.name ?? "index"),
    );
    if (index && this.settings.createIndex) {
      const indexed = views.flatMap((view) => {
        const exports = indexExports(view, (name) =>
          this.casing.schemaName(name),
        );
        if (exports === undefined) return [];
        return [{
          view,
          exports,
          className: this.casing.convertTypes(view.name),
          validatedTypeName: this.casing.validatedTypeName(view.name),
          fileBase: this.casing.fileBase(view.name),
        }];
      });
      const exportNames = indexed.flatMap((row) => [
        ...row.exports.split(", ").filter((name) => name.length > 0),
        row.validatedTypeName,
      ]);
      entries.push(
        content(
          index,
          fill(this.templates.indexTmpl, {
            withTypeAnnotation: true,
            types: indexed,
          }),
          bag({
            module: this.imports
              .viewValidatorRel(views[0]?.name ?? "index")
              .replace(/[^/]+$/, "index.ts"),
            exports: exportNames,
            imports: indexed.map((row) =>
              this.imports.viewValidatorRel(row.view.name),
            ),
            uses: exportNames,
          }),
        ),
      );
    }
    return entries;
  }

  private zodForField(field: TypeField): string {
    const refKind = fieldRefKind(field, this.typesByName);
    const nested =
      refKind === "datasource" && this.referenceBackendType
        ? this.casing.schemaName(`datasource_${field.base}`)
        : this.casing.schemaName(field.base);
    let expr =
      refKind === "primitive"
        ? tighten(field)
        : `z.lazy(() => ${nested})`;
    if (field.isArray) expr = `z.array(${expr})`;
    if (field.isNullable) expr += ".nullable()";
    return expr;
  }

  private collectImports(view: Type, expanded: Type | undefined) {
    const byPath = new Map<string, Set<string>>();
    const refs: Array<{ entity: string; kind: "view" | "datasource" }> = [];
    const parentName = isAlias(view) ? view.name : view.inherits;
    if (
      this.referenceBackendType &&
      parentName !== undefined &&
      (isAlias(view) || !isBuiltinInherit(view))
    ) {
      const parent = this.typesByName.get(parentName);
      if (isAlias(view) || (parent !== undefined && typeHasTag(parent, "datasource_type"))) {
        refs.push({ entity: parentName, kind: "datasource" });
      }
    }
    const fields = expanded?.fields ?? view.fields;
    for (const f of fields) {
      const refKind = fieldRefKind(f, this.typesByName);
      if (refKind === "primitive") continue;
      refs.push({
        entity: f.base,
        kind:
          !this.referenceBackendType && refKind === "datasource"
            ? "view"
            : refKind,
      });
    }
    const importRels: string[] = [];
    const useNames: string[] = [];
    for (const { entity, kind } of refs) {
      if (kind === "view" && entity === view.name) continue;
      const destRel =
        kind === "datasource"
          ? this.datasourceImports.datasourceValidatorRel(entity)
          : this.imports.viewValidatorRel(entity);
      const fromPath = this.imports.spec(
        this.imports.viewValidatorRel(view.name),
        destRel,
      );
      const schemaName = this.casing.schemaName(entity);
      const token =
        kind === "datasource"
          ? `${schemaName} as ${this.casing.schemaName(`datasource_${entity}`)}`
          : schemaName;
      const set = byPath.get(fromPath) ?? new Set();
      set.add(token);
      byPath.set(fromPath, set);
      if (!importRels.includes(destRel)) importRels.push(destRel);
      if (!useNames.includes(schemaName)) useNames.push(schemaName);
    }
    return {
      imports: [...byPath.entries()]
        .map(([fromPath, tokens]) => ({
          fromPath,
          names: [...tokens].sort().join(", "),
        }))
        .sort((a, b) => a.fromPath.localeCompare(b.fromPath)),
      importRels,
      useNames,
    };
  }

  private fileExports(
    view: Type,
    schemaName: string,
    validatedTypeName: string,
  ): string[] {
    const names = [schemaName, validatedTypeName];
    if (isWriteVariant(view.name)) return names;
    if ((view.removeFields?.length ?? 0) > 0) return names;
    const parentName = isAlias(view) ? view.name : view.inherits;
    const inheritBackend =
      this.referenceBackendType &&
      parentName !== undefined &&
      (isAlias(view) || !isBuiltinInherit(view));
    if (inheritBackend) return names;
    return [
      schemaName,
      this.casing.schemaName(`create_${view.name}`),
      this.casing.schemaName(`update_${view.name}`),
      this.casing.schemaName(`patch_${view.name}`),
      validatedTypeName,
    ];
  }

  private fieldTokens(fields: TypeField[]) {
    return fields.map((f) => ({
      ident: this.casing.fieldIdent(f.name),
      zodExpr: this.zodForField(f),
    }));
  }

  private schemaBody(
    view: Type,
    expanded: Type | undefined,
  ): string {
    const schemaName = this.casing.schemaName(view.name);
    const t = {
      create: this.casing.schemaName(`create_${view.name}`),
      update: this.casing.schemaName(`update_${view.name}`),
      patch: this.casing.schemaName(`patch_${view.name}`),
    };
    const parentName = isAlias(view) ? view.name : view.inherits;
    const inheritBackend =
      this.referenceBackendType &&
      parentName !== undefined &&
      (isAlias(view) || !isBuiltinInherit(view));
    const inlineFields = expanded?.fields ?? view.fields;
    const fields = [
      ...this.fieldTokens(
        inheritBackend && !isAlias(view) ? view.fields : inheritBackend ? [] : inlineFields,
      ),
      ...dictionariesForView(view, this.typesByName, this.dictionaries).map(
        (d) => ({
          ident: this.casing.fieldIdent(d.name),
          zodExpr: `z.record(${toZod(d.keyType)}, ${toZod(d.valueType)})`,
        }),
      ),
    ];
    if (!inheritBackend || parentName === undefined) {
      return fill(this.templates.schemaStandaloneTmpl, {
        schemaName,
        emptyObject: fields.length === 0,
        fields,
        hasTrio: (view.removeFields?.length ?? 0) === 0,
        createName: t.create,
        updateName: t.update,
        patchName: t.patch,
      }).trimEnd();
    }
    const parent = parentName;
    const parentFields = this.parentFieldsByName.get(parent) ?? new Set();
    const onParent = (keys: string[]) => keys.filter((k) => parentFields.has(k));
    const omits = onParent(view.removeFields ?? []);
    return fill(this.templates.schemaInheritTmpl, {
      schemaName,
      dsAlias: this.casing.schemaName(`datasource_${parent}`),
      hasOmits: omits.length > 0,
      omitObj: omitObj(omits.map((k) => this.casing.convertFields(k))),
      partialId: parentFields.has("id") && omits.length > 0 && !omits.includes("id"),
      hasFields: fields.length > 0,
      fields,
    }).trimEnd();
  }
}

/** Returns attributed entries. Cross-lane datasource schema imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
  mode: ViewValidatorEmitMode = {},
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  return new Generator(ctx.settings, mode).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};
