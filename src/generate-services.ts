import { toNative } from "./base-type-converter.ts";
import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, patch, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  DeterministicParser,
  type IDeterministic,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import {
  SERVICES_YAML,
  type CustomServiceEntry,
  type ServiceCandidate,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import { libraryImportSpecifier } from "./library-import.ts";
import { Emit } from "./emit.ts";
import {
  customStubTmpl,
  genericTmpl,
  indexTmpl,
} from "./resources/services.ts";

class Generator extends Emit {
  private viewNames = new Set<string>();

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.viewNames = new Set(deterministic.viewTypes.map((view) => view.name));
    const { generics, customs } = deterministic.services;
    const entries: GenerateEntry[] = [
      ...generics.map((c) => this.generic(c)),
      ...customs.map((c) => this.custom(c)),
    ];
    if (this.settings.createIndex) {
      entries.push(...this.indexes(generics, customs));
    }
    const modulePaths = this.customModulePathsPatch(customs);
    if (modulePaths !== undefined) entries.push(modulePaths);
    return entries;
  }

  /** By-feature emit paths are project-root relative; remap YAML `module:` so runtime load matches. */
  private customModulePathsPatch(
    customs: CustomServiceEntry[],
  ): GenerateEntry | undefined {
    const paths: Record<string, string> = {};
    for (const entry of customs) {
      if (entry.module === undefined || entry.module === "") continue;
      const laid = this.imports
        .serviceCustom(entry.name, entry.module)
        .replace(/\.ts$/, "");
      if (!laid.startsWith("features/")) continue;
      const mapped = `./${laid}`;
      if (mapped !== entry.module) paths[entry.module] = mapped;
    }
    if (Object.keys(paths).length === 0) return undefined;
    const literal = JSON.stringify(paths, null, 2).replace(/\n/g, "\n    ");
    return patch(
      this.imports.app(),
      `customModulePaths: ${literal},\n`,
      "APP_CUSTOM_MODULE_PATHS",
    );
  }

  private typeModule(candidate: ServiceCandidate): string {
    return candidate.kind === "datasource_type"
      ? this.imports.datasourceRel(candidate.name)
      : this.imports.viewRel(candidate.name);
  }

  private mutateView(name: string): string | undefined {
    if (this.viewNames.has(`create_${name}`)) return `create_${name}`;
    if (this.viewNames.has(`update_${name}`)) return `update_${name}`;
    return undefined;
  }

  private generic(candidate: ServiceCandidate): GenerateEntry {
    const { simpleDoc, descriptionDoc, libraryReferenceMode } = this.settings;
    const typeName = this.casing.convertTypes(candidate.name);
    const className = this.casing.serviceClassName(candidate.name);
    const interfaceName = this.casing.serviceInterfaceName(candidate.name);
    const generatePath = this.imports.service(candidate.name);
    const module = this.imports.serviceRel(candidate.name);
    const typeModule = this.typeModule(candidate);
    const typeImportPath = this.imports.spec(
      this.imports.serviceRel(candidate.name),
      candidate.kind === "datasource_type"
        ? this.imports.datasourceRel(candidate.name)
        : this.imports.viewRel(candidate.name),
    );
    const mutate = this.mutateView(candidate.name);
    const mutateTypeName =
      mutate === undefined ? false : this.casing.convertTypes(mutate);
    const mutateModule =
      mutate === undefined ? undefined : this.imports.viewRel(mutate);
    const mutateImport =
      mutate === undefined || mutateModule === undefined
        ? false
        : {
            mutateTypeName,
            mutateImportPath: this.imports.spec(
              this.imports.serviceRel(candidate.name),
              mutateModule,
            ),
          };
    const servicesImport = libraryImportSpecifier(
      "services",
      libraryReferenceMode,
      this.imports.serviceRel(candidate.name),
    );
    return content(
      generatePath,
      fill(genericTmpl, {
        simpleDoc,
        descriptionDoc,
        typeImport: true,
        typeName,
        typeImportPath,
        mutateTypeName,
        mutateImport,
        servicesImport,
        interfaceName,
        className,
        datasourceType: candidate.datasourceType ?? "standard",
        finders: candidate.byFields.map((bf) => ({
          method: this.casing.finderMethod(bf.field),
          param: this.casing.fieldIdent(bf.field),
          paramType: toNative(bf.type),
          field: this.casing.convertFields(bf.field),
          typeName,
        })),
      }),
      {
        module,
        exports: `${className}, ${interfaceName}`,
        imports: [typeModule, mutateModule]
          .filter((value): value is string => value !== undefined)
          .join(", "),
        uses: [typeName, mutateTypeName === false ? undefined : mutateTypeName]
          .filter((value): value is string => value !== undefined)
          .join(", "),
      },
    );
  }

  /** Map emit paths like `../custom/foo.ts` to Rel keys `services/custom/foo.ts`. */
  private customModuleKey(emitPath: string): string {
    if (emitPath.startsWith("../custom/")) {
      return `services/custom/${emitPath.slice("../custom/".length)}`;
    }
    return emitPath;
  }

  private custom(entry: CustomServiceEntry): GenerateEntry {
    const { simpleDoc, descriptionDoc } = this.settings;
    const className = entry.name;
    const interfaceName = this.casing.authoredInterfaceName(entry.name);
    const path = this.imports.serviceCustom(entry.name, entry.module);
    return content(
      path,
      fill(customStubTmpl, {
        simpleDoc,
        descriptionDoc,
        interfaceName,
        className,
        hasMethods: entry.methods.length > 0,
        methods: entry.methods.map((name) => ({ name })),
      }),
      {
        module: this.customModuleKey(path),
        exports: `${className}, ${interfaceName}`,
      },
    );
  }

  private indexes(
    generics: ServiceCandidate[],
    customs: CustomServiceEntry[],
  ): GenerateEntry[] {
    const entries: GenerateEntry[] = [];
    if (generics.length > 0) {
      const sorted = [...generics].sort((a, b) =>
        this.casing.serviceClassName(a.name).localeCompare(
          this.casing.serviceClassName(b.name),
        ),
      );
      const index = this.imports.index(this.imports.service(sorted[0]!.name));
      if (index) {
        const exports = sorted
          .flatMap((c) => [
            this.casing.serviceClassName(c.name),
            this.casing.serviceInterfaceName(c.name),
          ])
          .join(", ");
        entries.push(
          content(
            index,
            fill(indexTmpl, {
              types: sorted.map((c) => ({
                className: this.casing.serviceClassName(c.name),
                interfaceName: this.casing.serviceInterfaceName(c.name),
                fileBase: this.casing.fileBase(`${c.name}_service`),
              })),
            }),
            {
              module: this.imports
                .serviceRel(sorted[0]!.name)
                .replace(/[^/]+$/, "index.ts"),
              exports,
              imports: sorted
                .map((c) => this.imports.serviceRel(c.name))
                .join(", "),
              uses: exports,
            },
          ),
        );
      }
    }
    const customDirEntries = customs.filter(
      (e) => !e.module || !e.module.startsWith("."),
    );
    if (customDirEntries.length > 0) {
      const sorted = [...customDirEntries].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const index = this.imports.index(this.imports.serviceCustom(sorted[0]!.name));
      if (index) {
        const exports = sorted
          .flatMap((e) => [
            e.name,
            this.casing.authoredInterfaceName(e.name),
          ])
          .join(", ");
        const modules = sorted.map((e) =>
          this.customModuleKey(this.imports.serviceCustom(e.name, e.module)),
        );
        entries.push(
          content(
            index,
            fill(indexTmpl, {
              types: sorted.map((e) => ({
                className: e.name,
                interfaceName: this.casing.authoredInterfaceName(e.name),
                fileBase: this.casing.fileBase(e.name),
              })),
            }),
            {
              module: this.customModuleKey(index),
              exports,
              imports: modules.join(", "),
              uses: exports,
            },
          ),
        );
      }
    }
    return entries;
  }
}

/** Returns attributed entries. Cross-lane type imports need host `finalizeEntries` with views/datasource entries. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(SERVICES_YAML);
  const generator = new Generator(ctx.settings);
  return generator.from(
    await DeterministicParser(ctx.reader).parse(ctx.settings, {
      serviceClassName: (entity) => generator.casing.serviceClassName(entity),
    }),
  );
};
