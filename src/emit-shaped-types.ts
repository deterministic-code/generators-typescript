import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  authoredViewTypesOf,
  datasourceTypesOf,
  tableKind,
  TYPES_YAML,
  typeHasTag,
  typesWithTag,
  viewTypesOf,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type IDeterministic,
  type Type,
  type TypeField,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { toNative } from "./base-type-converter.ts";
import {
  dictionariesForView,
  ownedDictionariesOf,
  type OwnedDictionary,
} from "./common/owned-dictionaries.ts";
import { fieldRefKind, isAlias } from "./common/view-shape.ts";
import { bag, Emit } from "./emit.ts";
import {
  indexTmpl as defaultIndexTmpl,
  typeTmpl as defaultTypeTmpl,
} from "./resources/shaped-types.ts";

export type ShapedKind = "datasource" | "view";

export type ShapedTypeTemplates = {
  typeTmpl: string;
  indexTmpl: string;
};

export type ShapedEmitMode = {
  kind: ShapedKind;
  referenceBackendType?: boolean;
  templates?: ShapedTypeTemplates;
  /** Emit root. `""` / `"."` → backend layout. A directory → files under that dir, by-feature off. */
  basePath?: string;
  /** Import generator base for datasource types referenced from views. */
  datasourceBasePath?: string;
};

export type ViewEmitMode = Omit<ShapedEmitMode, "kind">;

const BUILTIN_PARENTS = new Set(["set", "dictionary", "file"]);

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
  private readonly kind: ShapedKind;
  private readonly referenceBackendType: boolean;
  private readonly templates: ShapedTypeTemplates;
  private typesByName = new Map<string, Type>();
  private dictionaries: OwnedDictionary[] = [];

  constructor(raw: Record<string, string>, mode: ShapedEmitMode) {
    super(raw, mode.basePath ?? ".", mode.datasourceBasePath ?? ".");
    this.kind = mode.kind;
    this.referenceBackendType =
      mode.kind === "view" && (mode.referenceBackendType ?? true);
    this.templates = mode.templates ?? {
      typeTmpl: defaultTypeTmpl,
      indexTmpl: defaultIndexTmpl,
    };
  }

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    this.dictionaries = ownedDictionariesOf(deterministic.expandedTypes);
    const authored =
      this.kind === "datasource"
        ? typesWithTag(deterministic.types, "datasource_type")
        : authoredViewTypesOf(deterministic);
    const expandedByName = new Map(
      (this.kind === "datasource"
        ? datasourceTypesOf(deterministic)
        : viewTypesOf(deterministic)
      ).map((t) => [t.name, t]),
    );
    const entries = authored.map((t) => this.type(t, expandedByName.get(t.name)));
    const index = this.imports.index(this.file(authored[0]?.name ?? "index"));
    if (index && this.settings.createIndex) {
      entries.push(this.index(authored, index));
    }
    return entries;
  }

  private file(name: string): string {
    return this.kind === "datasource"
      ? this.imports.datasource(name)
      : this.imports.view(name);
  }

  private rel(name: string): string {
    return this.kind === "datasource"
      ? this.imports.datasourceRel(name)
      : this.imports.viewRel(name);
  }

  private relKey(to: { entity: string; kind: "view" | "datasource" }): string {
    if (to.kind === "view") return this.imports.viewRel(to.entity);
    return this.kind === "datasource"
      ? this.imports.datasourceRel(to.entity)
      : this.datasourceImports.datasourceRel(to.entity);
  }

  private typeImport(
    from: string,
    to: { entity: string; kind: "view" | "datasource" },
  ): string {
    const dest =
      to.kind === "view"
        ? this.imports.viewRel(to.entity)
        : this.kind === "datasource"
          ? this.imports.datasourceRel(to.entity)
          : this.datasourceImports.datasourceRel(to.entity);
    return this.imports.spec(this.rel(from), dest);
  }

  private collectImports(type: Type, expanded: Type | undefined) {
    const self = type.name;
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
    for (const { entity, kind } of this.refs(type, expanded)) {
      if (entity === self && (this.kind === "datasource" || kind === "view")) {
        continue;
      }
      const typeName = this.casing.convertTypes(entity);
      const alias =
        this.kind === "view" &&
        this.referenceBackendType &&
        kind === "datasource" &&
        entity === self
          ? this.casing.baseTypeName(entity)
          : undefined;
      if (alias !== undefined) aliasByClass.set(entity, alias);
      add(typeName, alias, this.typeImport(type.name, { entity, kind }));
    }
    return { imports: groupImports(entries), aliasByClass };
  }

  private refs(
    type: Type,
    expanded: Type | undefined,
  ): Array<{ entity: string; kind: "view" | "datasource" }> {
    if (this.kind === "datasource") {
      return this.extendsType(type, new Map()) !== undefined &&
        type.inherits !== undefined &&
        !BUILTIN_PARENTS.has(type.inherits)
        ? [{ entity: type.inherits, kind: "datasource" }]
        : [];
    }
    const refs: Array<{ entity: string; kind: "view" | "datasource" }> = [];
    const parentName = isAlias(type) ? type.name : type.inherits;
    const parentType =
      parentName === undefined ? undefined : this.typesByName.get(parentName);
    if (
      this.referenceBackendType &&
      parentName !== undefined &&
      (isAlias(type) || !BUILTIN_PARENTS.has(parentName)) &&
      (isAlias(type) ||
        (parentType !== undefined && typeHasTag(parentType, "datasource_type")))
    ) {
      refs.push({ entity: parentName, kind: "datasource" });
    }
    for (const f of this.emitFields(type, expanded)) {
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
    return refs;
  }

  private fieldTs(
    field: TypeField,
    aliasByClass: Map<string, string>,
  ): string {
    if (this.kind === "datasource") return toNative(field.type);
    const refKind = fieldRefKind(field, this.typesByName);
    const base =
      refKind === "primitive"
        ? toNative(field.base)
        : (aliasByClass.get(field.base) ?? this.casing.convertTypes(field.base));
    return field.isArray ? `${base}[]` : base;
  }

  private extendsType(
    type: Type,
    aliasByClass: Map<string, string>,
  ): string | undefined {
    if (this.kind === "view" && !this.referenceBackendType) return undefined;
    const parentName =
      this.kind === "view" && isAlias(type) ? type.name : type.inherits;
    if (
      parentName === undefined ||
      (!(this.kind === "view" && isAlias(type)) &&
        BUILTIN_PARENTS.has(parentName))
    ) {
      return undefined;
    }
    if (this.kind === "view") {
      const parentType = this.typesByName.get(parentName);
      if (
        parentType !== undefined &&
        !typeHasTag(parentType, "datasource_type") &&
        !isAlias(type)
      ) {
        return undefined;
      }
    }
    const parent =
      aliasByClass.get(parentName) ?? this.casing.convertTypes(parentName);
    const omitKeys = type.removeFields ?? [];
    if (omitKeys.length === 0) return parent;
    return `Omit<${parent}, ${omitKeys.map((k) => JSON.stringify(this.casing.convertFields(k))).join(" | ")}>`;
  }

  private emitFields(type: Type, expanded: Type | undefined): TypeField[] {
    if (this.kind === "view" && this.referenceBackendType && isAlias(type)) {
      return [];
    }
    if (this.extendsType(type, new Map()) !== undefined) return type.fields;
    return expanded?.fields ?? type.fields;
  }

  private ownedDictionaryFields(type: Type): Array<{
    ident: string;
    tsType: string;
    nullable: boolean;
  }> {
    if (this.kind !== "view") return [];
    return dictionariesForView(type, this.typesByName, this.dictionaries).map(
      (d) => ({
        ident: this.casing.fieldIdent(d.name),
        tsType: `Dictionary<${toNative(d.keyType)}, ${toNative(d.valueType)}>`,
        nullable: false,
      }),
    );
  }

  private type(type: Type, expanded: Type | undefined): GenerateEntry {
    const { schemaVersion, simpleDoc, descriptionDoc } = this.settings;
    const className = this.casing.convertTypes(type.name);
    const { imports, aliasByClass } = this.collectImports(type, expanded);
    const parent = this.extendsType(type, aliasByClass);
    const fields = this.emitFields(type, expanded);
    const dictionaryFields = this.ownedDictionaryFields(type);
    const fieldTokens = [
      ...fields.map((f) => ({
        ident: this.casing.fieldIdent(f.name),
        tsType: this.fieldTs(f, aliasByClass),
        nullable: f.isNullable,
      })),
      ...dictionaryFields,
    ];
    const refs = this.refs(type, expanded);
    return content(
      this.file(type.name),
      fill(this.templates.typeTmpl, {
        schemaVersion,
        imports,
        hasImports: imports.length > 0,
        simpleDoc,
        descriptionDoc,
        docNoun: this.kind === "datasource" ? "Type" : "View",
        className,
        datasourceType: tableKind(type),
        target: this.kind === "datasource" ? "ShapedType" : "ShapedView",
        fieldCount: String(fieldTokens.length),
        isUnion: false,
        isShaped: true,
        hasExtends: parent !== undefined,
        extendsType: parent ?? "",
        hasFields: fieldTokens.length > 0,
        hasDictionary: dictionaryFields.length > 0,
        fields: fieldTokens,
        unionMembers: "",
      }),
      bag({
        module: this.rel(type.name),
        exports: className,
        imports: refs.map((r) => this.relKey(r)),
        uses: refs.map((r) => this.casing.convertTypes(r.entity)),
      }),
    );
  }

  private index(types: Type[], index: string): GenerateEntry {
    const modules = types.map((t) => this.rel(t.name));
    const exports = types.map((t) => this.casing.convertTypes(t.name)).join(", ");
    return content(
      index,
      fill(this.templates.indexTmpl, {
        types: types.map((t) => ({
          className: this.casing.convertTypes(t.name),
          fileBase: this.casing.fileBase(t.name),
        })),
      }),
      bag({
        module: this.rel(types[0]?.name ?? "index").replace(/[^/]+$/, "index.ts"),
        exports,
        imports: modules,
        uses: exports,
      }),
    );
  }
}

export const generateShapedTypes = async (
  ctx: GenerateContext,
  mode: ShapedEmitMode,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(TYPES_YAML);
  return new Generator(ctx.settings, mode).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};

export const generateViewTypes = async (
  ctx: GenerateContext,
  mode: ViewEmitMode = {},
): Promise<GenerateEntry[]> =>
  generateShapedTypes(ctx, { kind: "view", ...mode });
