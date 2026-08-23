import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  authoredViewTypesOf,
  tableKind,
  TYPES_YAML,
  typeHasTag,
  unionMembers,
  viewTypesOf,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { toNative } from "./base-type-converter.ts";
import { fieldRefKind, isAlias } from "./common/view-shape.ts";
import { Emit } from "./emit.ts";
import {
  indexTmpl as defaultIndexTmpl,
  typeTmpl as defaultTypeTmpl,
} from "./resources/view-types.ts";

export type ViewTypeTemplates = {
  typeTmpl: string;
  indexTmpl: string;
};

export type ViewEmitMode = {
  referenceBackendType?: boolean;
  templates?: ViewTypeTemplates;
  /** Emit root. `""` / `"."` → backend layout. A directory → files under that dir, by-feature off. */
  basePath?: string;
  /** Import generator base for datasource types referenced from views. */
  datasourceBasePath?: string;
};

const groupImports = (
  entries: Array<{ original: string; alias?: string; fromPath: string }>,
): Array<{ names: string; fromPath: string }> => {
  const byPath = new Map<string, string[]>();
  for (const e of entries) {
    const tokens = byPath.get(e.fromPath) ?? [];
    tokens.push(e.alias ? `${e.original} as ${e.alias}` : e.original);
    byPath.set(e.fromPath, tokens);
  }
  return [...byPath.entries()]
    .map(([fromPath, tokens]) => ({
      fromPath,
      names: [...new Set(tokens)].sort().join(", "),
    }))
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath));
};

class Generator extends Emit {
  private readonly referenceBackendType: boolean;
  private readonly templates: ViewTypeTemplates;
  private typesByName = new Map<string, Type>();

  constructor(raw: Record<string, string>, mode: ViewEmitMode) {
    super(raw, mode.basePath ?? ".", mode.datasourceBasePath ?? ".");
    this.referenceBackendType = mode.referenceBackendType ?? true;
    this.templates = mode.templates ?? {
      typeTmpl: defaultTypeTmpl,
      indexTmpl: defaultIndexTmpl,
    };
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    const expandedByName = new Map(
      viewTypesOf(deterministic).map((v) => [v.name, v]),
    );
    const views = authoredViewTypesOf(deterministic);
    const entries = views.map((v) => this.view(v, expandedByName.get(v.name)));
    const index = this.imports.index(this.imports.view(views[0]?.name ?? "index"));
    if (index && this.settings.createIndex) {
      entries.push(
        content(
          index,
          fill(this.templates.indexTmpl, {
            types: views.map((v) => ({
              className: this.casing.convertTypes(v.name),
              fileBase: this.casing.fileBase(v.name),
            })),
          }),
          {
            module: this.imports
              .viewRel(views[0]?.name ?? "index")
              .replace(/[^/]+$/, "index.ts"),
            exports: views
              .map((v) => this.casing.convertTypes(v.name))
              .join(", "),
            imports: views.map((v) => this.imports.viewRel(v.name)).join(", "),
            uses: views.map((v) => this.casing.convertTypes(v.name)).join(", "),
          },
        ),
      );
    }
    return entries;
  }

  private typeImport(
    from: string,
    to: { entity: string; kind: "view" | "datasource" },
  ): string {
    const rel =
      to.kind === "view"
        ? this.imports.viewRel(to.entity)
        : this.datasourceImports.datasourceRel(to.entity);
    return this.imports.spec(this.imports.viewRel(from), rel);
  }

  private importKind(kind: "view" | "datasource"): "view" | "datasource" {
    return !this.referenceBackendType && kind === "datasource" ? "view" : kind;
  }

  private collectImports(view: Type, expanded: Type | undefined) {
    const self = view.name;
    const entries: Array<{ original: string; alias?: string; fromPath: string }> =
      [];
    const seen = new Set<string>();
    const aliasByClass = new Map<string, string>();
    const add = (
      original: string,
      alias: string | undefined,
      fromPath: string,
    ) => {
      const key = `${fromPath}::${original}::${alias ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ original, alias, fromPath });
    };
    const refs: Array<{ entity: string; kind: "view" | "datasource" }> = [];
    const members = unionMembers(view);
    if (members !== undefined) {
      for (const m of members) refs.push({ entity: m, kind: "view" });
    } else {
      const parentName = isAlias(view) ? view.name : view.inherits;
      const parentType =
        parentName === undefined ? undefined : this.typesByName.get(parentName);
      if (
        this.referenceBackendType &&
        parentName !== undefined &&
        parentName !== "set" &&
        parentName !== "dictionary" &&
        (isAlias(view) ||
          (parentType !== undefined && typeHasTag(parentType, "datasource_type")))
      ) {
        refs.push({
          entity: parentName,
          kind: "datasource",
        });
      }
      const fields = this.emitFields(view, expanded);
      for (const f of fields) {
        const refKind = fieldRefKind(f, this.typesByName);
        if (refKind === "primitive") continue;
        refs.push({ entity: f.base, kind: this.importKind(refKind) });
      }
    }
    for (const { entity, kind } of refs) {
      if (kind === "view" && entity === self) continue;
      const typeName = this.casing.convertTypes(entity);
      const alias =
        this.referenceBackendType && kind === "datasource" && entity === self
          ? this.casing.baseTypeName(entity)
          : undefined;
      if (alias !== undefined) aliasByClass.set(entity, alias);
      add(typeName, alias, this.typeImport(view.name, { entity, kind }));
    }
    return { imports: groupImports(entries), aliasByClass };
  }

  private fieldTs(
    field: TypeField,
    aliasByClass: Map<string, string>,
  ): string {
    const refKind = fieldRefKind(field, this.typesByName);
    const base =
      refKind === "primitive"
        ? toNative(field.base)
        : (aliasByClass.get(field.base) ?? this.casing.convertTypes(field.base));
    return field.isArray ? `${base}[]` : base;
  }

  private extendsType(
    view: Type,
    aliasByClass: Map<string, string>,
  ): string | undefined {
    if (!this.referenceBackendType) return undefined;
    const parentName = isAlias(view) ? view.name : view.inherits;
    if (
      parentName === undefined ||
      parentName === "set" ||
      parentName === "dictionary"
    ) {
      return undefined;
    }
    const parentType = this.typesByName.get(parentName);
    if (parentType !== undefined && !typeHasTag(parentType, "datasource_type") && !isAlias(view)) {
      return undefined;
    }
    const parent =
      aliasByClass.get(parentName) ?? this.casing.convertTypes(parentName);
    const omitKeys = view.removeFields ?? [];
    if (omitKeys.length === 0) return parent;
    return `Omit<${parent}, ${omitKeys.map((k) => JSON.stringify(this.casing.convertFields(k))).join(" | ")}>`;
  }

  private emitFields(view: Type, expanded: Type | undefined): TypeField[] {
    if (unionMembers(view) !== undefined) return [];
    if (this.referenceBackendType && isAlias(view)) return [];
    if (this.referenceBackendType && this.extendsType(view, new Map()) !== undefined) {
      return view.fields;
    }
    return expanded?.fields ?? view.fields;
  }

  private view(
    view: Type,
    expanded: Type | undefined,
  ): GenerateEntry {
    const { schemaVersion, simpleDoc, descriptionDoc } = this.settings;
    const className = this.casing.convertTypes(view.name);
    const { imports, aliasByClass } = this.collectImports(view, expanded);
    const members = unionMembers(view);
    const isUnion = members !== undefined;
    const parent = isUnion ? undefined : this.extendsType(view, aliasByClass);
    const fields = this.emitFields(view, expanded);
    const path = this.imports.view(view.name);
    return content(
      path,
      fill(this.templates.typeTmpl, {
        schemaVersion,
        imports,
        hasImports: imports.length > 0,
        simpleDoc,
        descriptionDoc,
        className,
        datasourceType: isUnion ? "standard" : tableKind(view),
        target: isUnion ? "UnionView" : "ShapedView",
        fieldCount: String(isUnion ? members.length : fields.length),
        isUnion,
        isShaped: !isUnion,
        hasExtends: parent !== undefined,
        extendsType: parent ?? "",
        hasFields: fields.length > 0,
        fields: fields.map((f) => ({
          ident: this.casing.fieldIdent(f.name),
          tsType: this.fieldTs(f, aliasByClass),
          nullable: f.isNullable,
        })),
        unionMembers: isUnion
          ? members.map((m) => this.casing.convertTypes(m)).join(" | ")
          : "",
      }),
      { module: this.imports.viewRel(view.name), exports: className },
    );
  }
}

export const generateViewTypes = async (
  ctx: GenerateContext,
  mode: ViewEmitMode = {},
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  return new Generator(ctx.settings, mode).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};
