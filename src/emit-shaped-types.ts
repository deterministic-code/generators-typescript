import { posix } from "node:path";
import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  authoredViewTypesOf,
  datasourceTypesOf,
  dictionaryEntryFields,
  dictionaryOfField,
  persistedColumnFields,
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
} from "@deterministic-code/deterministic-generators-common/parser";
import {
  collectionDefaultExpr,
  nativeDefaultExpr,
  toNative,
  tsLanguageZero,
} from "./deterministic-type-converter.ts";
import { fieldRefKind } from "./common/view-shape.ts";
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
  entries: Array<{
    original: string;
    alias?: string;
    fromPath: string;
    isValue?: boolean;
  }>,
): Array<{ names: string; fromPath: string; isValue: boolean }> => {
  const byPath = new Map<
    string,
    { fromPath: string; isValue: boolean; tokens: string[] }
  >();
  for (const e of entries) {
    const isValue = e.isValue === true;
    const key = `${e.fromPath}\0${isValue}`;
    const group = byPath.get(key) ?? { fromPath: e.fromPath, isValue, tokens: [] };
    group.tokens.push(e.alias ? `${e.original} as ${e.alias}` : e.original);
    byPath.set(key, group);
  }
  return [...byPath.values()]
    .map((group) => ({
      fromPath: group.fromPath,
      isValue: group.isValue,
      names: [...new Set(group.tokens)].sort().join(", "),
    }))
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath));
};

const classKey = (kind: ShapedKind, name: string): string => `${kind}:${name}`;

const camel = () => (text: string, render: (value: string) => string) => {
  const name = render(text);
  return `${name[0]!.toLowerCase()}${name.slice(1)}`;
};

class Generator extends Emit {
  private readonly kind: ShapedKind;
  private readonly referenceBackendType: boolean;
  private readonly templates: ShapedTypeTemplates;
  private typesByName = new Map<string, Type>();
  private classSet = new Set<string>();

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
    this.classSet = this.computeClassSet(deterministic);
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

  private collectImports(
    type: Type,
    expanded: Type | undefined,
    flatten: boolean,
    isClass: boolean,
  ) {
    const self = type.name;
    const entries: Array<{
      original: string;
      alias?: string;
      fromPath: string;
      isValue?: boolean;
    }> = [];
    const seen = new Set<string>();
    const aliasByClass = new Map<string, string>();
    const add = (
      original: string,
      alias: string | undefined,
      fromPath: string,
      isValue: boolean,
    ) => {
      const key = `${fromPath}::${original}::${alias ?? ""}::${isValue}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ original, alias, fromPath, isValue });
    };
    for (const { entity, kind } of this.refs(type, expanded, flatten)) {
      if (entity === self && (this.kind === "datasource" || kind === "view")) {
        continue;
      }
      const typeName = this.casing.entityName(entity);
      const alias =
        this.kind === "view" &&
        this.referenceBackendType &&
        kind === "datasource" &&
        typeName === this.casing.entityName(self)
          ? this.casing.baseTypeName(entity)
          : undefined;
      if (alias !== undefined) aliasByClass.set(entity, alias);
      const isValue =
        isClass &&
        this.classSet.has(classKey(kind, entity)) &&
        type.inherits === entity;
      add(
        typeName,
        alias,
        this.typeImport(type.name, { entity, kind }),
        isValue,
      );
    }
    return { imports: groupImports(entries), aliasByClass };
  }

  private refs(
    type: Type,
    expanded: Type | undefined,
    flatten = false,
  ): Array<{ entity: string; kind: "view" | "datasource" }> {
    if (this.kind === "datasource") {
      return !flatten &&
        this.extendsType(type, new Map()) !== undefined &&
        type.inherits !== undefined &&
        !BUILTIN_PARENTS.has(type.inherits)
        ? [{ entity: type.inherits, kind: "datasource" }]
        : [];
    }
    const refs: Array<{ entity: string; kind: "view" | "datasource" }> = [];
    for (const f of this.emitFields(type, expanded, flatten)) {
      const mapped = dictionaryOfField(f, this.typesByName);
      const entry = mapped === undefined ? undefined : dictionaryEntryFields(mapped);
      const target = entry?.value ?? f;
      const refKind = fieldRefKind(target, this.typesByName);
      if (refKind === "primitive") continue;
      refs.push({
        entity: target.base,
        kind:
          !this.referenceBackendType && refKind === "datasource"
            ? "view"
            : refKind,
      });
    }
    return refs;
  }

  private partTs(
    field: TypeField,
    aliasByClass: Map<string, string>,
  ): string {
    const refKind = fieldRefKind(field, this.typesByName);
    return refKind === "primitive"
      ? toNative(field.base)
      : (aliasByClass.get(field.base) ?? this.casing.entityName(field.base));
  }

  private fieldTs(
    field: TypeField,
    aliasByClass: Map<string, string>,
  ): string {
    if (this.kind === "datasource") {
      return toNative(field.type);
    }
    const dict = dictionaryOfField(field, this.typesByName);
    const entry = dict === undefined ? undefined : dictionaryEntryFields(dict);
    if (entry !== undefined) {
      return `Dictionary<${this.partTs(entry.key, aliasByClass)}, ${this.partTs(entry.value, aliasByClass)}>`;
    }
    const base = this.partTs(field, aliasByClass);
    return field.isArray ? `${base}[]` : base;
  }

  private extendsType(
    type: Type,
    aliasByClass: Map<string, string>,
    kind: ShapedKind = this.kind,
  ): string | undefined {
    if (kind === "view") return undefined;
    const parentName = type.inherits;
    if (parentName === undefined || BUILTIN_PARENTS.has(parentName)) return undefined;
    const parentType = this.typesByName.get(parentName);
    if (parentType === undefined || !typeHasTag(parentType, "datasource_type")) {
      return undefined;
    }
    const parent =
      aliasByClass.get(parentName) ?? this.casing.entityName(parentName);
    const omitKeys = type.removeFields ?? [];
    if (omitKeys.length === 0) return parent;
    return `Omit<${parent}, ${omitKeys.map((k) => JSON.stringify(this.casing.convertFields(k))).join(" | ")}>`;
  }

  private remainingFields(type: Type, expanded: Type | undefined): TypeField[] {
    const fields = expanded?.fields ?? type.fields;
    return this.kind === "datasource"
      ? persistedColumnFields({ ...type, fields }, this.typesByName)
      : fields;
  }

  private droppedViewFields(type: Type): Set<string> {
    return new Set(
      (type.removeFields ?? []).map((key) => this.casing.fieldIdent(key)),
    );
  }

  private emitFields(
    type: Type,
    expanded: Type | undefined,
    flatten = false,
    kind: ShapedKind = this.kind,
  ): TypeField[] {
    if (kind === "view") {
      const dropped = this.droppedViewFields(type);
      return (expanded?.fields ?? type.fields).filter(
        (field) => !dropped.has(this.casing.fieldIdent(field.name)),
      );
    }
    if (flatten) return this.remainingFields(type, expanded);
    if (this.extendsType(type, new Map(), kind) !== undefined) {
      return persistedColumnFields(type, this.typesByName);
    }
    const fields = expanded?.fields ?? type.fields;
    return persistedColumnFields({ ...type, fields }, this.typesByName);
  }

  private computeClassSet(deterministic: IDeterministic): Set<string> {
    const classes = new Set<string>();
    for (const type of typesWithTag(deterministic.types, "datasource_type")) {
      classes.add(classKey("datasource", type.name));
    }
    for (const type of authoredViewTypesOf(deterministic)) {
      classes.add(classKey("view", type.name));
    }
    return classes;
  }

  private type(type: Type, expanded: Type | undefined): GenerateEntry {
    const { schemaVersion, simpleDoc, descriptionDoc } = this.settings;
    const className = this.casing.entityName(type.name);
    const isClass =
      this.kind === "view" || this.classSet.has(classKey(this.kind, type.name));
    const flatten =
      isClass && (this.extendsType(type, new Map())?.startsWith("Omit<") ?? false);
    const { imports, aliasByClass } = this.collectImports(
      type,
      expanded,
      flatten,
      isClass,
    );
    const fields = this.emitFields(type, expanded, flatten);
    const refs = this.refs(type, expanded, flatten);
    return content(
      this.file(type.name),
      fill(this.templates.typeTmpl, {
        schemaVersion,
        imports,
        simpleDoc,
        descriptionDoc,
        className,
        camel,
        datasource: this.kind === "datasource",
        datasourceType: tableKind(type),
        isClass,
        extendsType: flatten ? "" : (this.extendsType(type, aliasByClass) ?? ""),
        fields: Object.assign(
          fields.map((f) => {
            const initializer =
              collectionDefaultExpr(f) ??
              (f.kind === "primitive"
                ? nativeDefaultExpr(f.type, f) ?? tsLanguageZero(f.type, f)
                : undefined);
            return {
              ident: this.casing.fieldIdent(f.name),
              tsType: this.fieldTs(f, aliasByClass),
              nullable: f.isNullable,
              isMap: f.isMap === true,
              initializer: isClass && initializer !== undefined ? ` = ${initializer}` : "",
            };
          }),
          { dictionary: fields.some((f) => f.isMap === true) },
        ),
      }),
      bag({
        module: this.rel(type.name),
        exports: className,
        imports: refs.map((r) => this.relKey(r)),
        uses: refs.map((r) => this.casing.entityName(r.entity)),
      }),
    );
  }

  private index(types: Type[], index: string): GenerateEntry {
    const modules = types.map((t) => this.rel(t.name));
    const exports = types.map((t) => this.casing.entityName(t.name)).join(", ");
    return content(
      index,
      fill(this.templates.indexTmpl, {
        camel,
        types: types.map((t) => ({
          className: this.casing.entityName(t.name),
          fileBase: posix.basename(this.file(t.name), ".ts"),
          isClass:
            this.kind === "view" ||
            this.classSet.has(classKey(this.kind, t.name)),
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
