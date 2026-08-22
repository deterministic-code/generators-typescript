import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  VIEW_TYPES_YAML,
  type ViewField,
  type ViewType,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { toZod } from "./common/type-converters/native-to-zod.ts";
import { Emit } from "./emit.ts";
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

const tighten = (field: ViewField): string => {
  const base = toZod(field.base);
  switch (field.base) {
    case "string":
    case "character": {
      let expr = `${base}.trim()`;
      if (field.minSize !== undefined && field.minSize >= 0) expr += `.min(${field.minSize})`;
      if (field.size !== undefined && field.size >= 0) expr += `.max(${field.size})`;
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
      if (field.size !== undefined) expr += `.max(${field.size})`;
      return expr;
    }
    default:
      return base;
  }
};

const indexExports = (
  view: ViewType,
  schemaName: (name: string) => string,
): string | undefined => {
  const schema = schemaName(view.name);
  if (view.kind === "union") return schema;
  if (isWriteVariant(view.name)) return schema;
  if (view.omit.length > 0) return undefined;
  if (view.inherits !== null) return schema;
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
    this.parentFieldsByName = new Map(
      deterministic.expandedDatasourceTypes.map((table) => [
        table.name,
        new Set(table.fields.map((field) => field.name)),
      ]),
    );
    const expandedByName = new Map(
      deterministic.expandedViewTypes.map((v) => [v.name, v]),
    );
    const views = deterministic.viewTypes;
    const entries = views.map((view) =>
      content(
        this.imports.viewValidator(view.name),
        fill(this.templates.typeTmpl, {
          schemaVersion: this.settings.schemaVersion,
          imports: this.collectImports(view),
          schemaBody: this.schemaBody(view, expandedByName.get(view.name)),
          withTypeAnnotation: true,
          className: this.casing.convertTypes(view.name),
          schemaName: this.casing.schemaName(view.name),
          validatedTypeName: this.casing.validatedTypeName(view.name),
        }),
      ),
    );
    const index = this.imports.index(
      this.imports.viewValidator(views[0]?.name ?? "index"),
    );
    if (index && this.settings.createIndex) {
      entries.push(
        content(
          index,
          fill(this.templates.indexTmpl, {
            withTypeAnnotation: true,
            types: views.flatMap((view) => {
              const exports = indexExports(view, (name) =>
                this.casing.schemaName(name),
              );
              if (exports === undefined) return [];
              return [{
                exports,
                className: this.casing.convertTypes(view.name),
                validatedTypeName: this.casing.validatedTypeName(view.name),
                fileBase: this.casing.fileBase(view.name),
              }];
            }),
          }),
        ),
      );
    }
    return entries;
  }

  private zodForField(field: ViewField): string {
    const nested =
      field.kind === "datasource" && this.referenceBackendType
        ? this.casing.schemaName(`datasource_${field.base}`)
        : this.casing.schemaName(field.base);
    let expr =
      field.kind === "primitive"
        ? tighten(field)
        : `z.lazy(() => ${nested})`;
    if (field.isArray) expr = `z.array(${expr})`;
    if (field.isNullable) expr += ".nullable()";
    return expr;
  }

  private collectImports(view: ViewType) {
    const byPath = new Map<string, Set<string>>();
    const refs: Array<{ entity: string; kind: "view" | "datasource" }> = [];
    if (view.kind === "shaped") {
      if (this.referenceBackendType && view.inherits !== null) {
        refs.push({ entity: view.inherits, kind: "datasource" });
      }
      for (const f of view.fields) {
        if (f.kind === "datasource" || f.kind === "view") {
          refs.push({
            entity: f.base,
            kind:
              !this.referenceBackendType && f.kind === "datasource"
                ? "view"
                : f.kind,
          });
        }
      }
    } else {
      for (const m of view.members) refs.push({ entity: m, kind: "view" });
    }
    for (const { entity, kind } of refs) {
      if (kind === "view" && entity === view.name) continue;
      const fromPath = this.imports.spec(
        this.imports.viewValidatorRel(view.name),
        kind === "datasource"
          ? this.datasourceImports.datasourceValidatorRel(entity)
          : this.imports.viewValidatorRel(entity),
      );
      const token =
        kind === "datasource"
          ? `${this.casing.schemaName(entity)} as ${this.casing.schemaName(`datasource_${entity}`)}`
          : this.casing.schemaName(entity);
      const set = byPath.get(fromPath) ?? new Set();
      set.add(token);
      byPath.set(fromPath, set);
    }
    return [...byPath.entries()]
      .map(([fromPath, tokens]) => ({
        fromPath,
        names: [...tokens].sort().join(", "),
      }))
      .sort((a, b) => a.fromPath.localeCompare(b.fromPath));
  }

  private fieldTokens(fields: ViewField[]) {
    return fields.map((f) => ({
      ident: this.casing.fieldIdent(f.name),
      zodExpr: this.zodForField(f),
    }));
  }

  private schemaBody(
    view: ViewType,
    expanded: ViewType | undefined,
  ): string {
    const schemaName = this.casing.schemaName(view.name);
    if (view.kind === "union") {
      return fill(this.templates.schemaUnionTmpl, {
        schemaName,
        members: view.members.map((m) => ({
          ident: this.casing.schemaName(m),
        })),
      }).trimEnd();
    }
    const t = {
      create: this.casing.schemaName(`create_${view.name}`),
      update: this.casing.schemaName(`update_${view.name}`),
      patch: this.casing.schemaName(`patch_${view.name}`),
    };
    const inheritBackend = this.referenceBackendType && view.inherits !== null;
    const inlineFields =
      expanded?.kind === "shaped" ? expanded.fields : view.fields;
    const fields = this.fieldTokens(
      inheritBackend ? view.fields : inlineFields,
    );
    if (!inheritBackend || view.inherits === null) {
      return fill(this.templates.schemaStandaloneTmpl, {
        schemaName,
        emptyObject: fields.length === 0,
        fields,
        hasTrio: view.omit.length === 0,
        createName: t.create,
        updateName: t.update,
        patchName: t.patch,
      }).trimEnd();
    }
    const parent = view.inherits;
    const parentFields = this.parentFieldsByName.get(parent) ?? new Set();
    const onParent = (keys: string[]) => keys.filter((k) => parentFields.has(k));
    const omits = onParent(view.omit);
    const allOmits = onParent([
      ...view.enrichments.map((e) => e.fkColumn),
      ...view.omit,
    ]);
    return fill(this.templates.schemaInheritTmpl, {
      schemaName,
      dsAlias: this.casing.schemaName(`datasource_${parent}`),
      hasOmits: allOmits.length > 0,
      omitObj: omitObj(allOmits.map((k) => this.casing.convertFields(k))),
      partialId: parentFields.has("id") && omits.length > 0 && !omits.includes("id"),
      hasFields: fields.length > 0,
      fields,
    }).trimEnd();
  }
}

export const generate = async (
  ctx: GenerateContext,
  mode: ViewValidatorEmitMode = {},
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(VIEW_TYPES_YAML);
  return new Generator(ctx.settings, mode).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};
