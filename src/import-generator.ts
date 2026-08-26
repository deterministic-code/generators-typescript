import { posix } from "node:path";
import type { IImportGenerator } from "@deterministic-code/generators-common/import-generator";
import { createCasing, type PackCasing } from "./common/default-casing.ts";

const importSpec = (fromFile: string, toFile: string): string => {
  const toNoExt = toFile.endsWith(".ts") ? toFile.slice(0, -3) : toFile;
  const rel = posix.relative(posix.dirname(fromFile), toNoExt);
  return rel.startsWith(".") ? rel : `./${rel}`;
};

const modulePathParts = (mod: string): string[] => {
  const parts = mod.split("/").filter((p) => p !== "" && p !== ".");
  while (parts.length && parts[0] === "..") parts.shift();
  return parts;
};

export class TypeScriptImportGenerator implements IImportGenerator {
  private readonly organizeByFeature: boolean;
  private readonly flat: boolean;
  private readonly basePath: string;
  private readonly casing: PackCasing;

  constructor(basePath: string, settings: Record<string, string>) {
    this.basePath = basePath;
    this.flat = basePath !== "" && basePath !== ".";
    this.organizeByFeature =
      !this.flat && settings["other.organize_by_feature"] === "true";
    this.casing = createCasing(settings);
  }

  datasource(entity: string): string {
    const file = this.organizeByFeature
      ? `${this.casing.fileBase(entity)}.datasource.ts`
      : this.tsFile(entity);
    const path = this.organizeByFeature
      ? this.featurePath(entity, file)
      : file;
    return this.underBase(path);
  }

  datasourceRel(entity: string): string {
    return this.rel("types/generated/datasource", this.datasource(entity));
  }

  datasourceQual(entity: string): string {
    return this.casing.convertTypes(entity);
  }

  datasourceValidator(entity: string): string {
    const file = this.organizeByFeature
      ? `${this.casing.fileBase(entity)}.datasource.validator.ts`
      : this.tsFile(entity);
    const path = this.organizeByFeature
      ? this.featurePath(entity, file)
      : file;
    return this.underBase(path);
  }

  datasourceValidatorRel(entity: string): string {
    return this.rel(
      "types/generated/datasource/validators",
      this.datasourceValidator(entity),
    );
  }

  datasourceTestRel(entity: string): string {
    return this.rel(
      "types/generated/datasource",
      this.test(this.datasource(entity), entity),
    );
  }

  datasourceValidatorTestRel(entity: string): string {
    return this.rel(
      "types/generated/datasource/validators",
      this.test(this.datasourceValidator(entity), entity),
    );
  }

  view(entity: string): string {
    return this.underBase(this.viewLike(entity, ""));
  }

  viewRel(entity: string): string {
    return this.rel("types/generated/views", this.view(entity));
  }

  viewQual(entity: string): string {
    return this.casing.convertTypes(entity);
  }

  viewValidator(entity: string): string {
    return this.underBase(this.viewLike(entity, ".validator"));
  }

  viewValidatorRel(entity: string): string {
    return this.rel(
      "types/generated/views/validators",
      this.viewValidator(entity),
    );
  }

  viewTestRel(entity: string): string {
    return this.rel("types/generated/views", this.test(this.view(entity), entity));
  }

  viewValidatorTestRel(entity: string): string {
    return this.rel(
      "types/generated/views/validators",
      this.test(this.viewValidator(entity), entity),
    );
  }

  validatorTestRel(kind: "datasource" | "view", entity: string): string {
    return kind === "datasource"
      ? this.datasourceValidatorTestRel(entity)
      : this.viewValidatorTestRel(entity);
  }

  service(entity: string): string {
    const file = `${this.serviceStem(entity)}.ts`;
    const path = this.organizeByFeature
      ? this.featurePath(entity, file)
      : file;
    return this.underBase(path);
  }

  serviceRel(entity: string): string {
    return this.rel("services/generated", this.service(entity));
  }

  serviceCustom(name: string, module?: string): string {
    return this.resolveCustom(name, module, "services");
  }

  serviceCustomRel(entity: string): string {
    const file = `${this.serviceStem(entity)}.ts`;
    return this.organizeByFeature
      ? `features/${this.casing.directory(entity)}/custom/${file}`
      : `services/custom/${file}`;
  }

  serviceTest(entity: string): string {
    const file = `${this.serviceStem(entity)}.test.ts`;
    const path = this.organizeByFeature
      ? `features/${this.casing.directory(entity)}/__tests__/${file}`
      : file;
    return this.underBase(path);
  }

  serviceTestRel(entity: string): string {
    return this.rel("services/generated/__tests__", this.serviceTest(entity));
  }

  serviceIntegrationTest(entity: string): string {
    return this.serviceTest(entity).replace(/\.test\.ts$/, ".integration.test.ts");
  }

  serviceIntegrationTestRel(entity: string): string {
    return this.rel(
      "services/generated/__tests__",
      this.serviceIntegrationTest(entity),
    );
  }

  serviceUse(_entity: string, _symbol: string): string {
    return "";
  }

  route(entity: string): string {
    const file = this.organizeByFeature
      ? `${this.casing.fileBase(entity)}.route.ts`
      : this.tsFile(entity);
    const path = this.organizeByFeature
      ? this.featurePath(entity, file)
      : file;
    return this.underBase(path);
  }

  routeRel(entity: string): string {
    return this.rel("routes/generated", this.route(entity));
  }

  routeCustom(name: string, module?: string): string {
    return this.resolveCustom(name, module, "routes");
  }

  routeTest(entity: string): string {
    const file = `${this.casing.fileBase(entity)}.integration.test.ts`;
    const path = this.organizeByFeature
      ? `features/${this.casing.directory(entity)}/__tests__/${file}`
      : file;
    return this.underBase(path);
  }

  routeTestRel(entity: string): string {
    return this.rel("routes/generated/__tests__", this.routeTest(entity));
  }

  enrichment(_targetTable: string): string {
    return "";
  }

  test(srcFile: string, fileBase: string): string {
    if (this.organizeByFeature) {
      const stem = posix.basename(srcFile).replace(/\.ts$/, "");
      return `${posix.dirname(srcFile)}/__tests__/${stem}.test.ts`;
    }
    return srcFile.replace(/\.ts$/, ".test.ts");
  }

  testSpec(srcFile: string, fileBase: string): string {
    if (!srcFile.includes("/")) return `../${this.casing.fileBase(fileBase)}`;
    return importSpec(this.test(srcFile, fileBase), srcFile);
  }

  index(beside: string): string {
    if (this.organizeByFeature) return "";
    return posix.join(posix.dirname(beside), "index.ts");
  }

  spec(fromFile: string, toFile: string): string {
    return importSpec(fromFile, toFile);
  }

  routeModule(entity: string): string {
    return this.casing.fileBase(entity);
  }

  appWiring(): string {
    return "";
  }

  validatorFn(
    _kind: "datasource" | "view",
    _entity: string,
    _fn: string,
  ): string {
    return "";
  }

  apiPath(entity: string): string {
    return entity.replace(/_/g, "-");
  }

  frontend(relPath: string): string {
    return posix.join("frontend", relPath);
  }

  app(): string {
    return this.casing.filePath("app");
  }

  server(): string {
    return this.casing.filePath("server");
  }

  appTest(stem: string): string {
    return `__tests__/${this.casing.fileBase(stem)}.test.ts`;
  }

  /** Layered types/services/routes globs, or features when by-feature. Empty when flat. */
  tsconfigIncludes(): string[] {
    if (this.flat) return [];
    if (this.organizeByFeature) return ["features/**/*.ts"];
    return ["types/**/*.ts", "services/**/*.ts", "routes/**/*.ts"];
  }

  private rel(prefix: string, file: string): string {
    if (this.organizeByFeature || this.flat) return file;
    return `${prefix}/${file}`;
  }

  private tsFile(stem: string): string {
    return `${this.casing.fileBase(stem)}.ts`;
  }

  private featurePath(entity: string, file: string): string {
    return `features/${this.casing.directory(entity)}/${file}`;
  }

  private serviceStem(entity: string): string {
    return this.casing.fileBase(`${entity}_service`);
  }

  private underBase(file: string): string {
    if (!this.flat) return file;
    return `${this.basePath}/${file}`;
  }

  private viewLike(entity: string, featureExt: string): string {
    const file = `${this.casing.fileBase(entity)}${this.organizeByFeature ? featureExt : ""}.ts`;
    return this.organizeByFeature
      ? `features/${this.casing.directory(entity)}/${file}`
      : file;
  }

  private resolveCustom(
    name: string,
    mod: string | undefined,
    layer: "services" | "routes",
  ): string {
    const kind = layer === "services" ? "service" : "route";
    const stubFn =
      layer === "services"
        ? "generateCustomServiceStub"
        : "generateCustomRouteStub";
    const file =
      layer === "services"
        ? this.tsFile(name)
        : `${this.casing.fileBase(`${name}_route`)}.ts`;
    const defaultStub = this.organizeByFeature
      ? `features/${this.casing.directory(name)}/custom/${file}`
      : `../custom/${file}`;
    if (this.organizeByFeature) {
      if (
        typeof mod !== "string" ||
        !mod.startsWith(".") ||
        mod.startsWith("./services/") ||
        mod.startsWith("./routes/")
      ) {
        return defaultStub;
      }
      const parts = modulePathParts(mod);
      if (parts[0] !== "features") {
        throw new Error(
          `${stubFn}: ${kind} "${name}" has module "${mod}" which is outside ./features/. ` +
            `When organize=by-feature, custom ${layer} must live under features/<entity>/custom/. ` +
            `Drop the module: field to use the convention default (${defaultStub.replace(/\.ts$/, "")}), ` +
            `or point module: into ./features/.`,
        );
      }
      return `${parts.join("/")}.ts`;
    }
    if (!mod || !mod.startsWith(".")) return defaultStub;
    const parts = modulePathParts(mod);
    if (parts[0] === layer) parts.shift();
    return `../${parts.join("/")}.ts`;
  }
}

export const createImportGenerator = (
  basePath: string,
  settings: Record<string, string>,
): TypeScriptImportGenerator =>
  new TypeScriptImportGenerator(basePath, settings);
