import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  isReadonlyLookup,
  ROUTES_YAML,
  tableKind,
} from "@deterministic-code/generators-common/spec-types";
import {
  DeterministicParser,
  type CustomRouteEntry,
  type IDeterministic,
  type RouteCandidate,
  type Type,
} from "@deterministic-code/deterministic-generators-common/parser";
import type { PackCasing } from "./common/default-casing.ts";
import { isDictionaryCandidate } from "./common/dictionary-candidate.ts";
import { bag, customRelKey, Emit } from "./emit.ts";
import {
  crudTmpl,
  customStubTmpl,
  indexTmpl,
  readonlyTmpl,
} from "./resources/routes.ts";

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

  from(deterministic: IDeterministic): GenerateEntry[] {
    this.typesByName = new Map(
      deterministic.expandedTypes.map((t) => [t.name, t]),
    );
    const parsed = deterministic.routes;
    const candidates = parsed.candidates.filter(
      (c) => !isDictionaryCandidate(c),
    );
    const entries: GenerateEntry[] = [
      ...candidates.map((c) => this.entityRouter(c)),
      ...parsed.customs.map((c) => this.custom(c)),
    ];
    if (this.settings.createIndex) {
      entries.push(...this.indexes(candidates, parsed.customs));
    }
    return entries;
  }

  private customModuleKey(emitPath: string): string {
    return customRelKey(emitPath, this.casing.convertDirectories("routes"));
  }

  private entityRouter(candidate: RouteCandidate): GenerateEntry {
    const { simpleDoc, descriptionDoc } = this.settings;
    const entity = candidate.name;
    const type = this.typesByName.get(entity);
    const readOnly = type !== undefined && isReadonlyLookup(type);
    const fnName = this.casing.routerFnName(entity);
    return content(
      this.imports.route(entity),
      fill(readOnly ? readonlyTmpl : crudTmpl, {
        simpleDoc,
        descriptionDoc,
        fnName,
        datasourceType:
          type === undefined ? "standard" : tableKind(type),
      }),
      bag({
        module: this.imports.routeRel(entity),
        exports: fnName,
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
