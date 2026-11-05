import { CodegenNames } from "./codegen-naming.ts";
import { CodegenFieldNames } from "./field-names.ts";
import { CodegenLayout } from "./codegen-layout.ts";
import { normalizeAll } from "./view-expand.ts";

type NormalizeFn = (config: any) => any[];
type RenderFn = (entity: any, ctx: any) => any;
type IndexLineFn = (entity: any, ctx: any) => string | null;
type ImportsCtor = new (ctx: any) => unknown;

interface EntityGeneratorOptions {
  normalize?: NormalizeFn;
  render?: RenderFn;
  indexLine?: IndexLineFn;
  Imports?: ImportsCtor;
}

interface GenerateContext {
  opts: any;
  names: CodegenNames;
  fields: CodegenFieldNames;
  layout: CodegenLayout;
  byFeature: boolean;
  imports?: unknown;
}

/** Shared `generate(config)` engine every entity generator delegates to: builds `ctx` (names/fields/layout, optional imports) from `config`, maps each source entity through `render`, and appends a barrel index when `config.createIndex` is set. Each generator supplies its entity source (`normalize`), the per-entity `render`, an optional `indexLine`, and an optional language `Imports` renderer class. */
export class EntityGenerator {
  normalize?: NormalizeFn;
  render?: RenderFn;
  indexLine?: IndexLineFn;
  Imports?: ImportsCtor;

  constructor({
    normalize,
    render,
    indexLine,
    Imports,
  }: EntityGeneratorOptions = {}) {
    this.normalize = normalize;
    this.render = render;
    this.indexLine = indexLine;
    this.Imports = Imports;
  }

  generate(config: any): any[] {
    const casing = config.settings?.languages?.[config.language]?.casing ?? {};
    const namesSettings = {
      languages: {
        [config.language]: {
          casing: {
            fileNames: config.fileFormat ?? casing.fileNames,
            types: config.classFormat ?? casing.types,
            fields: config.fieldFormat ?? casing.fields,
            directories: config.dirFormat ?? casing.directories ?? "Auto",
          },
        },
      },
      other: {
        organizeByFeature:
          config.organizeByFeature ??
          config.settings?.other?.organizeByFeature,
      },
    };
    const names = new CodegenNames(namesSettings, config.language);
    const fields = new CodegenFieldNames({ fieldFormat: names.fieldFormat });
    const layout = new CodegenLayout(names);
    const ctx: GenerateContext = {
      opts: config,
      names,
      fields,
      layout,
      byFeature: names.byFeature,
    };
    if (this.Imports) ctx.imports = new this.Imports(ctx);
    const entities = this.normalize!(config);
    const files = entities.map((entity) => this.render!(entity, ctx));
    // A central `index.ts` barrel is flat-only; by-feature slices are imported directly (its `./<entity>` re-exports would be root-relative to files under `features/<dir>/`).
    if (this.indexLine && config.createIndex && !ctx.byFeature) {
      const lines = entities
        .map((entity) => this.indexLine!(entity, ctx))
        .filter((line) => line != null);
      files.push({
        path: `index${ctx.names.ext}`,
        content: `${lines.join("\n")}\n`,
      });
    }
    return files;
  }
}

/** `createGenerator` for a datasource-types generator: source is `config.datasourceTypes.types` mapped through `normalizeTable`. */
export const datasourceTypesGenerator =
  (
    normalizeTable: (entry: any) => any,
    render: RenderFn,
    indexLine?: IndexLineFn,
  ) =>
  (Imports?: ImportsCtor) =>
    new EntityGenerator({
      normalize: (config) => config.datasourceTypes.types.map(normalizeTable),
      render,
      indexLine,
      Imports,
    });

/** `createGenerator` for a view generator: source is `normalizeAll(config.viewTypes)`. */
export const viewGenerator =
  (render: RenderFn, indexLine?: IndexLineFn) => (Imports?: ImportsCtor) =>
    new EntityGenerator({
      normalize: (config) => normalizeAll(config.viewTypes),
      render,
      indexLine,
      Imports,
    });

/** `createGenerator` for a datasource-validator generator: source is the raw `config.datasourceTypes.types`. */
export const datasourceValidatorGenerator =
  (render: RenderFn, indexLine?: IndexLineFn) => (Imports?: ImportsCtor) =>
    new EntityGenerator({
      normalize: (config) => config.datasourceTypes.types,
      render,
      indexLine,
      Imports,
    });

/** `createGenerator` for a datasource-tests generator: identity normalize + adapter feeding the whole `datasourceTypes` to the module's `generateForTable`. */
export const datasourceTestsGenerator = (
  generateForTable: (entry: any, datasourceTypes: any, opts: any) => any,
) =>
  datasourceTypesGenerator(
    (entry) => entry,
    (entry, ctx) => generateForTable(entry, ctx.opts.datasourceTypes, ctx.opts),
  );

/** Legacy `generateFromSchema` for a datasource-tests generator (colocated unit tests). */
export const datasourceTestsGenerateFromSchema =
  (generateForTable: (entry: any, data: any, options: any) => any) =>
  (data: any, options: any) =>
    (data.types ?? []).map((entry: any) => generateForTable(entry, data, options));
