import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  authoredViewTypesOf,
  datasourceTypesOf,
  dictionaryEntryFields,
  dictionaryOfField,
  fieldTypeOf,
  isCollectionField,
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
import { nativeDefaultExpr, toNative } from "./deterministic-type-converter.ts";
import { fieldRefKind, fieldsBeyondParent, isAlias } from "./common/view-shape.ts";
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
      const typeName = this.casing.convertTypes(entity);
      const alias =
        this.kind === "view" &&
        this.referenceBackendType &&
        kind === "datasource" &&
        entity === self
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
    const parentName = isAlias(type) ? type.name : type.inherits;
    const parentType =
      parentName === undefined ? undefined : this.typesByName.get(parentName);
    if (
      !flatten &&
      this.referenceBackendType &&
      parentName !== undefined &&
      (isAlias(type) || !BUILTIN_PARENTS.has(parentName)) &&
      (isAlias(type) ||
        (parentType !== undefined && typeHasTag(parentType, "datasource_type")))
    ) {
      refs.push({ entity: parentName, kind: "datasource" });
    }
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
      : (aliasByClass.get(field.base) ?? this.casing.convertTypes(field.base));
  }

  private fieldTs(
    field: TypeField,
    aliasByClass: Map<string, string>,
  ): string {
    if (this.kind === "datasource") {
      return toNative(fieldTypeOf(field, this.typesByName));
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
    referenceBackendType: boolean = this.referenceBackendType,
  ): string | undefined {
    if (kind === "view" && !referenceBackendType) return undefined;
    const parentName =
      kind === "view" && isAlias(type) ? type.name : type.inherits;
    if (
      parentName === undefined ||
      (!(kind === "view" && isAlias(type)) &&
        BUILTIN_PARENTS.has(parentName))
    ) {
      return undefined;
    }
    if (kind === "view") {
      const parentType = this.typesByName.get(parentName);
      if (
        parentType !== undefined &&
        !typeHasTag(parentType, "datasource_type") &&
        !isAlias(type)
      ) {
        return undefined;
      }
    }
    if (kind === "datasource") {
      const parentType = this.typesByName.get(parentName);
      if (
        parentType === undefined ||
        !typeHasTag(parentType, "datasource_type")
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

  private remainingFields(type: Type, expanded: Type | undefined): TypeField[] {
    const fields = expanded?.fields ?? type.fields;
    return this.kind === "datasource"
      ? persistedColumnFields({ ...type, fields }, this.typesByName)
      : fields;
  }

  private emitFields(
    type: Type,
    expanded: Type | undefined,
    flatten = false,
    kind: ShapedKind = this.kind,
    referenceBackendType: boolean = this.referenceBackendType,
  ): TypeField[] {
    if (flatten) return this.remainingFields(type, expanded);
    if (kind === "view" && referenceBackendType && isAlias(type)) {
      return (expanded?.fields ?? type.fields).filter(isCollectionField);
    }
    if (this.extendsType(type, new Map(), kind, referenceBackendType) !== undefined) {
      if (kind === "datasource") {
        return persistedColumnFields(type, this.typesByName);
      }
      const parentName = isAlias(type) ? type.name : type.inherits;
      const parent =
        parentName === undefined ? undefined : this.typesByName.get(parentName);
      return fieldsBeyondParent(expanded?.fields ?? type.fields, parent);
    }
    const fields = expanded?.fields ?? type.fields;
    return kind === "datasource"
      ? persistedColumnFields(
          { ...type, fields },
          this.typesByName,
        )
      : fields;
  }

  private hasNonZeroDefault(
    type: Type,
    expanded: Type | undefined,
    kind: ShapedKind,
    referenceBackendType: boolean,
  ): boolean {
    return this.emitFields(
      type,
      expanded,
      false,
      kind,
      referenceBackendType,
    ).some(
      (field) =>
        field.kind === "primitive" &&
        nativeDefaultExpr(fieldTypeOf(field, this.typesByName), field) !==
          undefined,
    );
  }

  private namedParent(
    type: Type,
    kind: ShapedKind,
    referenceBackendType: boolean,
  ): { entity: string; kind: ShapedKind } | undefined {
    const rendered = this.extendsType(
      type,
      new Map(),
      kind,
      referenceBackendType,
    );
    if (rendered === undefined || rendered.startsWith("Omit<")) return undefined;
    if (kind === "datasource") {
      return type.inherits === undefined
        ? undefined
        : { entity: type.inherits, kind: "datasource" };
    }
    const parentName = isAlias(type) ? type.name : type.inherits;
    return parentName === undefined
      ? undefined
      : { entity: parentName, kind: "datasource" };
  }

  private computeClassSet(deterministic: IDeterministic): Set<string> {
    const expandedDatasource = new Map(
      datasourceTypesOf(deterministic).map((type) => [type.name, type]),
    );
    const expandedViews = new Map(
      viewTypesOf(deterministic).map((type) => [type.name, type]),
    );
    const parents = new Map<string, { entity: string; kind: ShapedKind }>();
    const seeds = new Set<string>();
    const consider = (
      type: Type,
      expanded: Type | undefined,
      kind: ShapedKind,
    ): void => {
      if (type.kind === "union") return;
      if (kind === "view" && isAlias(type)) return;
      const key = classKey(kind, type.name);
      if (this.hasNonZeroDefault(type, expanded, kind, true)) seeds.add(key);
      const parent = this.namedParent(type, kind, true);
      if (parent !== undefined) parents.set(key, parent);
    };
    for (const type of typesWithTag(deterministic.types, "datasource_type")) {
      consider(type, expandedDatasource.get(type.name), "datasource");
    }
    for (const type of authoredViewTypesOf(deterministic)) {
      consider(type, expandedViews.get(type.name), "view");
    }
    const classes = new Set(seeds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const key of [...classes]) {
        const parent = parents.get(key);
        if (parent === undefined) continue;
        const parentKey = classKey(parent.kind, parent.entity);
        if (classes.has(parentKey)) continue;
        classes.add(parentKey);
        grew = true;
      }
    }
    return classes;
  }

  private type(type: Type, expanded: Type | undefined): GenerateEntry {
    const { schemaVersion, simpleDoc, descriptionDoc } = this.settings;
    const className = this.casing.convertTypes(type.name);
    const isClass = this.classSet.has(classKey(this.kind, type.name));
    const parentProbe = this.extendsType(type, new Map());
    const flatten =
      isClass && parentProbe !== undefined && parentProbe.startsWith("Omit<");
    const { imports, aliasByClass } = this.collectImports(
      type,
      expanded,
      flatten,
      isClass,
    );
    const parent = flatten ? undefined : this.extendsType(type, aliasByClass);
    const fields = this.emitFields(type, expanded, flatten);
    const fieldTokens = fields.map((f) => {
      const initializer =
        f.kind === "primitive"
          ? nativeDefaultExpr(fieldTypeOf(f, this.typesByName), f)
          : undefined;
      return {
        ident: this.casing.fieldIdent(f.name),
        tsType: this.fieldTs(f, aliasByClass),
        nullable: f.isNullable,
        hasInitializer: isClass && initializer !== undefined,
        initializer: initializer ?? "",
        definite: isClass && initializer === undefined,
      };
    });
    const refs = this.refs(type, expanded, flatten);
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
        isClass,
        hasExtends: parent !== undefined,
        extendsType: parent ?? "",
        hasFields: fieldTokens.length > 0,
        hasDictionary: fields.some((f) => f.isMap === true),
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
          isClass: this.classSet.has(classKey(this.kind, t.name)),
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
