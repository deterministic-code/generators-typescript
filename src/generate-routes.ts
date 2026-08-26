import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  isReadonlyLookup,
  ROUTES_YAML,
  tableByName,
  tableKind,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type CustomRouteEntry,
  type IDeterministic,
  type RouteByField,
  type DatasourceTable,
  type RouteCandidate,
  type Type,
} from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { PackCasing } from "./common/default-casing.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { bag, customRelKey, Emit } from "./emit.ts";
import {
  byFieldDeleteListTmpl,
  byFieldDeleteUniqueTmpl,
  byFieldGetListTmpl,
  byFieldGetUniqueTmpl,
  byFieldPutListTmpl,
  byFieldPutUniqueTmpl,
  crudTmpl,
  customStubTmpl,
  indexTmpl,
  readonlyTmpl,
} from "./resources/routes.ts";

const methodsOf = (entry: RouteByField, fallback: string[]): string[] =>
  Array.isArray(entry.methods) ? entry.methods : fallback;

const BY_FIELD_TMPLS = {
  GET: { unique: byFieldGetUniqueTmpl, list: byFieldGetListTmpl },
  PUT: { unique: byFieldPutUniqueTmpl, list: byFieldPutListTmpl },
  DELETE: { unique: byFieldDeleteUniqueTmpl, list: byFieldDeleteListTmpl },
} as const;

const byFieldsBlock = (entity: string, entries: RouteByField[]): string =>
  entries
    .map((entry) => {
      const methods = methodsOf(entry, ["GET", "PUT", "DELETE"]);
      const tokens = { entity, byField: entry.byField };
      const kind = entry.byFieldUnique ? "unique" : "list";
      return (["GET", "PUT", "DELETE"] as const)
        .filter((method) => methods.includes(method))
        .map((method) => fill(BY_FIELD_TMPLS[method][kind], tokens).trimEnd())
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

const byFieldsNeedsZod = (entries: RouteByField[]): boolean =>
  entries.some((e) => methodsOf(e, ["GET", "PUT", "DELETE"]).includes("PUT"));

const customRouteMeta = (entry: CustomRouteEntry, casing: PackCasing) => {
  const className = entry.routeClass ?? casing.convertTypes(entry.name);
  return {
    module: entry.module,
    className,
    interfaceName: casing.convertTypes(`i_${className}`),
  };
};

class Generator extends Emit {
  private typesByName = new Map<string, Type>();
  private tables = new Map<string, DatasourceTable>();

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    this.tables = tableByName(deterministic);
    const parsed = deterministic.routes;
    const customServices = new Set(
      deterministic.services.customs.map((entry) => entry.name),
    );
    const entries: GenerateEntry[] = [
      ...parsed.candidates.map((c) => this.entityRouter(c, customServices)),
      ...parsed.customs.map((c) => this.custom(c)),
    ];
    if (this.settings.createIndex) {
      entries.push(...this.indexes(parsed.candidates, parsed.customs));
    }
    return entries;
  }

  private libImports(entity: string, customService: boolean) {
    const projectRel = this.imports.routeRel(entity);
    const serviceRel = customService
      ? this.imports.serviceCustomRel(entity)
      : this.imports.serviceRel(entity);
    const mode = this.settings.libraryReferenceMode;
    return {
      serviceImport: this.imports.spec(projectRel, serviceRel),
      routesImport: libraryImportSpecifier("routes", mode, projectRel),
      responsesImport: libraryImportSpecifier("responses", mode, projectRel),
      errorsImport: libraryImportSpecifier("errors", mode, projectRel),
    };
  }

  private customModuleKey(emitPath: string): string {
    return customRelKey(emitPath, "routes");
  }

  private entityRouter(
    candidate: RouteCandidate,
    customServices: Set<string>,
  ): GenerateEntry {
    const { simpleDoc, descriptionDoc } = this.settings;
    const entity = candidate.name;
    const type = this.typesByName.get(entity);
    const table = this.tables.get(entity);
    const occ = this.settings.usesOptimisticConcurrency({
      tags: type?.tags ?? candidate.tags,
      useOptimisticConcurrency: table?.useOptimisticConcurrency,
    });
    const readOnly = type !== undefined && isReadonlyLookup(type);
    const byFields = readOnly
      ? candidate.byFields.map((e) => ({
          ...e,
          methods: methodsOf(e, ["GET"]).filter((m) => m === "GET"),
        }))
      : candidate.byFields;
    const customService = customServices.has(entity);
    const fnName = this.casing.routerFnName(entity);
    const serviceInterfaceName = this.casing.serviceInterfaceName(entity);
    const serviceRel = customService
      ? this.imports.serviceCustomRel(entity)
      : this.imports.serviceRel(entity);
    return content(
      this.imports.route(entity),
      fill(readOnly ? readonlyTmpl : crudTmpl, {
        simpleDoc,
        descriptionDoc,
        ...this.libImports(entity, customService),
        entity,
        fnName,
        serviceInterfaceName,
        datasourceType:
          type === undefined ? "standard" : tableKind(type),
        occ,
        needsZod: byFieldsNeedsZod(byFields),
        hasByFields: byFields.length > 0,
        byFieldsBlock: byFieldsBlock(entity, byFields),
      }),
      bag({
        module: this.imports.routeRel(entity),
        exports: fnName,
        imports: serviceRel,
        uses: serviceInterfaceName,
      }),
    );
  }

  private custom(entry: CustomRouteEntry): GenerateEntry {
    const { simpleDoc, descriptionDoc } = this.settings;
    const { module, className, interfaceName } = customRouteMeta(
      entry,
      this.casing,
    );
    const path = this.imports.routeCustom(entry.name, module);
    return content(
      path,
      fill(customStubTmpl, {
        simpleDoc,
        descriptionDoc,
        interfaceName,
        className,
      }),
      bag({
        module: this.customModuleKey(path),
        exports: [className, interfaceName],
      }),
    );
  }

  private indexes(
    candidates: RouteCandidate[],
    customs: CustomRouteEntry[],
  ): GenerateEntry[] {
    const entries: GenerateEntry[] = [];
    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
      const index = this.imports.index(this.imports.route(sorted[0]!.name));
      if (index) {
        const exports = sorted
          .map((c) => this.casing.routerFnName(c.name))
          .join(", ");
        entries.push(
          content(
            index,
            fill(indexTmpl, {
              routers: sorted.map((c) => ({
                fnName: this.casing.routerFnName(c.name),
                fileBase: this.casing.fileBase(c.name),
              })),
            }),
            bag({
              module: this.imports
                .routeRel(sorted[0]!.name)
                .replace(/[^/]+$/, "index.ts"),
              exports,
              imports: sorted.map((c) => this.imports.routeRel(c.name)),
              uses: exports,
            }),
          ),
        );
      }
    }
    const customDir = customs.filter((e) => {
      const { module } = customRouteMeta(e, this.casing);
      return module === undefined || !module.startsWith(".");
    });
    if (customDir.length > 0) {
      const sorted = [...customDir].sort((a, b) => a.name.localeCompare(b.name));
      const index = this.imports.index(this.imports.routeCustom(sorted[0]!.name));
      if (index) {
        const exports = sorted
          .flatMap((e) => {
            const { className, interfaceName } = customRouteMeta(
              e,
              this.casing,
            );
            return [className, interfaceName];
          })
          .join(", ");
        entries.push(
          content(
            index,
            fill(indexTmpl, {
              types: sorted.map((e) => {
                const { className, interfaceName } = customRouteMeta(
                  e,
                  this.casing,
                );
                return {
                  className,
                  interfaceName,
                  fileBase: this.casing.fileBase(`${e.name}_route`),
                };
              }),
            }),
            bag({
              module: this.customModuleKey(index),
              exports,
              imports: sorted.map((e) =>
                this.customModuleKey(
                  this.imports.routeCustom(e.name, e.module),
                ),
              ),
              uses: exports,
            }),
          ),
        );
      }
    }
    return entries;
  }
}

/** Returns attributed entries. Cross-lane service imports need host `finalizeEntries`. */
export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  await ctx.reader.read(ROUTES_YAML);
  return new Generator(ctx.settings).from(
    await DeterministicParser(ctx.reader).parse(ctx.settings),
  );
};
