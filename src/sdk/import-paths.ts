import { join } from "node:path";
import { kebab, tokenize } from "./case.ts";

export const STEPS = Object.freeze({
  MIGRATE_SCRIPTS: "migrate_scripts",
  BACKEND_APP: "backend_app",
  DATASOURCE_TYPES: "datasource_types",
  DATASOURCE_TYPE_VALIDATORS: "datasource_type_validators",
  DATASOURCE_TYPES_TESTS: "datasource_types_tests",
  VIEW_TYPES: "view_types",
  VIEW_TYPE_VALIDATORS: "view_type_validators",
  VIEW_TYPES_TESTS: "view_types_tests",
  SERVICES: "services",
  SERVICE_TESTS: "service_tests",
  SERVICE_INTEGRATION_TESTS: "service_integration_tests",
  ROUTES: "routes",
  ROUTES_TESTS: "routes_tests",
  ROUTES_E2E_TEST: "routes_e2e_test",
  PERF_PLAN: "performance_plan",
  PERF_E2E_TESTS: "perf_e2e_tests",
  PERF_SERVER: "perf_server",
});

const SRC = "src";
const CRATE = "crate";
const TESTS = "tests";
const OUT_ROOT = "outRoot";

interface LayoutEntry {
  dir: string;
  kind?: string;
  byFeatureCollapse?: boolean;
}

const TABLE: Record<string, Record<string, LayoutEntry>> = {
  typescript: {
    migrate_scripts: { dir: "" },
    backend_app: { dir: "" },
    datasource_types: {
      dir: "types/generated/datasource",
      byFeatureCollapse: true,
    },
    datasource_type_validators: {
      dir: "types/generated/datasource/validators",
      byFeatureCollapse: true,
    },
    datasource_types_tests: {
      dir: "types/generated/datasource/__tests__",
      byFeatureCollapse: true,
    },
    view_types: { dir: "types/generated/views", byFeatureCollapse: true },
    view_type_validators: {
      dir: "types/generated/views/validators",
      byFeatureCollapse: true,
    },
    view_types_tests: {
      dir: "types/generated/views/__tests__",
      byFeatureCollapse: true,
    },
    services: { dir: "services/generated", byFeatureCollapse: true },
    service_tests: {
      dir: "services/generated/__tests__",
      byFeatureCollapse: true,
    },
    service_integration_tests: {
      dir: "services/generated/__tests__",
      byFeatureCollapse: true,
    },
    routes: { dir: "routes/generated", byFeatureCollapse: true },
    routes_tests: {
      dir: "routes/generated/__tests__",
      byFeatureCollapse: true,
    },
    routes_e2e_test: { dir: "__tests__" },
    perf_e2e_tests: { dir: "__tests__" },
    perf_server: { dir: "" },
    performance_plan: {
      kind: OUT_ROOT,
      dir: "deterministic/performance-plan.yaml",
    },
  },
  rust: {
    migrate_scripts: { dir: "", kind: CRATE },
    backend_app: { dir: "", kind: CRATE },
    datasource_types: {
      dir: "types/generated/datasource",
      byFeatureCollapse: true,
    },
    datasource_type_validators: {
      dir: "types/generated/datasource/validators",
      byFeatureCollapse: true,
    },
    datasource_types_tests: {
      dir: "types/generated/datasource/tests",
      byFeatureCollapse: true,
    },
    view_types: { dir: "types/generated/views", byFeatureCollapse: true },
    view_type_validators: {
      dir: "types/generated/views/validators",
      byFeatureCollapse: true,
    },
    view_types_tests: {
      dir: "types/generated/views/tests",
      byFeatureCollapse: true,
    },
    services: { dir: "services/generated", byFeatureCollapse: true },
    service_tests: { kind: TESTS, dir: "" },
    service_integration_tests: { kind: TESTS, dir: "" },
    routes: { dir: "routes/generated", byFeatureCollapse: true },
    routes_tests: { kind: TESTS, dir: "" },
    routes_e2e_test: { kind: TESTS, dir: "" },
    perf_e2e_tests: { kind: TESTS, dir: "" },
    perf_server: { kind: CRATE, dir: "" },
    performance_plan: {
      kind: OUT_ROOT,
      dir: "deterministic/performance-plan.yaml",
    },
  },
  csharp: {
    migrate_scripts: { dir: "" },
    backend_app: { dir: "" },
    datasource_types: { dir: "datasource_types" },
    datasource_type_validators: { dir: "datasource_validators" },
    datasource_types_tests: { dir: "datasource_tests" },
    view_types: { dir: "view_types" },
    view_type_validators: { dir: "view_validators" },
    view_types_tests: { dir: "view_tests" },
    services: { dir: "Services/Generated" },
    service_tests: { dir: "Tests/Services" },
    routes: { dir: "Routes/Generated" },
    routes_tests: { dir: "Tests/Routes" },
  },
};

export function languageRoot({
  outRoot,
  language,
  kind = SRC,
}: {
  outRoot: string;
  language: string;
  kind?: string;
}): string {
  if (kind === OUT_ROOT) return outRoot;
  if (language === "rust") {
    if (kind === SRC) return join(outRoot, "src");
    if (kind === TESTS) return join(outRoot, "tests");
    return outRoot;
  }
  return outRoot;
}

// Both Pascal (HealthCheckService) and camel (healthCheckService) tokenize to the same lowercase tokens, so the suffix strip works for either input shape.
const CUSTOM_SUFFIX_TOKENS = new Set(["service", "route"]);

function targetFileBase(artifact: string, entity: string): string {
  switch (artifact) {
    case "datasource-type":
      return entity;
    case "datasource-validator":
      return `${entity}.validator`;
    case "view-type":
      return `${entity}-view`;
    case "view-validator":
      return `${entity}-view.validator`;
    case "service":
      return `${entity}-service`;
    case "route":
      return entity;
    default:
      throw new Error(`Unknown target artifact: ${artifact}`);
  }
}

/** The one helper that owns codegen output directories, feature-entity derivation, and by-feature stub paths. */
export class ImportPaths {
  /** Where step `step` for `language` generates, given the multi-lang / by-feature layout. */
  static outputDir({
    outRoot,
    step,
    language,
    organizeByFeature = false,
  }: {
    outRoot: string;
    step: string;
    language: string;
    organizeByFeature?: boolean;
  }): string {
    const cfg = TABLE[language]?.[step];
    if (!cfg) {
      throw new Error(`No layout entry for language=${language} step=${step}`);
    }
    const root = languageRoot({ outRoot, language, kind: cfg.kind ?? SRC });
    if (organizeByFeature && cfg.byFeatureCollapse) return root;
    return cfg.dir ? join(root, cfg.dir) : root;
  }

  /** The feature-entity a custom class belongs to: HealthCheckService -> "health-check". A bare suffix (Service/Route) stays as-is; callers fall back to a generic location. */
  static featureEntity(className: string): string {
    if (!className || typeof className !== "string") return "";
    const tokens = tokenize(className);
    if (tokens.length === 0) return "";
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && CUSTOM_SUFFIX_TOKENS.has(last)) {
      tokens.pop();
    }
    return tokens.join("-");
  }

  /** By-feature stub path: features/<entity>/custom/<fileBase><ext>; bare-suffix names collapse to "shared". snakeDir swaps kebab for rust snake feature dirs. */
  static customStubPath({
    className,
    fileBase,
    ext,
    snakeDir = false,
  }: {
    className: string;
    fileBase: string;
    ext: string;
    snakeDir?: boolean;
  }): string {
    const entity = ImportPaths.featureEntity(className) || "shared";
    const featureDir = snakeDir ? entity.replace(/-/g, "_") : entity;
    return `features/${featureDir}/custom/${fileBase}${ext}`;
  }

  /** Feature-relative import from `fromEntity`'s file to `toEntity`'s `toArtifact` file: `./x` when same feature, `../x/x-view` across features. fromTestSubdir adds a level for files under a feature's test dir. */
  static importSpecifier({
    fromEntity,
    toEntity,
    toArtifact,
    fromTestSubdir = false,
    fileBaseOverride,
    targetSubdir,
  }: {
    fromEntity: string;
    toEntity: string;
    toArtifact: string;
    fromTestSubdir?: boolean;
    fileBaseOverride?: string;
    targetSubdir?: string;
  }): string {
    const fromKebab = kebab(fromEntity);
    const toKebab = kebab(toEntity);
    const base = fileBaseOverride ?? targetFileBase(toArtifact, toKebab);
    const seg = targetSubdir ? `${targetSubdir}/${base}` : base;
    if (fromKebab === toKebab) {
      return fromTestSubdir ? `../${seg}` : `./${seg}`;
    }
    return fromTestSubdir ? `../../${toKebab}/${seg}` : `../${toKebab}/${seg}`;
  }
}
