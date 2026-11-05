import { posix } from "node:path";
import { toCase, apiPathSegment } from "./case.ts";
import { ImportPaths, STEPS } from "./import-paths.ts";
import { backendLaneDir } from "./backend-lane.ts";
import type { CodegenNames } from "./codegen-naming.ts";

const ARTIFACT_STEP: Record<string, string> = Object.freeze({
  "datasource-type": STEPS.DATASOURCE_TYPES,
  "view-type": STEPS.VIEW_TYPES,
  "view-validator": STEPS.VIEW_TYPE_VALIDATORS,
  service: STEPS.SERVICES,
  route: STEPS.ROUTES,
  enrichment: STEPS.ROUTES,
});

/** The container's sql root — a deliberately DECOUPLED constant, not a host-relative path. The Dockerfile always flattens the backend-shared sql tree to this absolute path regardless of the host lane→shared depth (`sql` vs `../sql`), so the entrypoint and the docker-run pretest read migrations at a location that never depends on `multiLanguage`. The single literal behind `containerSqlRoot()`/`containerMigrationsDir()`; do NOT derive it from `migrateRoot()`, which would re-couple the container frame to the host layout the flatten deliberately severs. */
export const CONTAINER_SQL_ROOT = "/app/sql";

interface ArtifactRef {
  entity: string;
  artifact: string;
}

/** Owns codegen PLACEMENT: generated paths (flat vs `features/<dir>/`), feature directories (dirFormat), and cross-artifact relative import specifiers. Composes filenames/classnames from the `CodegenNames` it wraps. */
export class CodegenLayout {
  names: CodegenNames;

  constructor(names: CodegenNames) {
    this.names = names;
  }

  /** Generated path relative to the PROJECT ROOT (not the step dir): by-feature is already root-relative; flat prepends the step's output dir from ImportPaths so callers stop hardcoding `types/generated/...`. */
  srcPath(entity: string, artifact: string): string {
    if (this.names.byFeature) return this.filePath(entity, artifact);
    const step = ARTIFACT_STEP[artifact];
    if (!step) {
      throw new Error(`srcPath: no step mapping for artifact=${artifact}`);
    }
    const dir = ImportPaths.outputDir({
      outRoot: "",
      step,
      language: this.names.language,
    });
    return `${dir}/${this.filePath(entity, artifact)}`;
  }

  /** The `/api/<plural>` URL path segment for an entity — kebab-cased plural with underscores hyphenated (e.g. `user_tag` → `user-tags`). */
  apiPath(entity: string): string {
    return apiPathSegment(entity);
  }

  /** The feature-directory name for the artifact's entity (update variants collapse into the base entity). */
  featureDir(entity: string, artifact: string): string {
    return toCase(
      this.names.featureEntity(entity, artifact),
      this.names.dirFormat,
    );
  }

  /** By-feature generated path for a caller-supplied filename: `features/<dir>/<file>`. Test generators bake their own suffix onto `file` (e.g. `.test.ts`), so they hand the filename in rather than letting `filePath` compose it from the naming rules. */
  featurePath(entity: string, artifact: string, file: string): string {
    return `features/${this.featureDir(entity, artifact)}/${file}`;
  }

  /** Generated file path relative to the step output dir: bare filename when flat, `features/<dir>/<file>` under by-feature. The mode is resolved from settings on `names`. */
  filePath(entity: string, artifact: string): string {
    const { names } = this;
    const roleExt = names.byFeature ? names.bfRoleExt(artifact) : "";
    const file = `${names.fileBase(entity, artifact)}${roleExt}${names.ext}`;
    return names.byFeature ? this.featurePath(entity, artifact, file) : file;
  }

  /** The migrations root relative to the lane's package.json: `sql` when the lane IS the backend-shared sql root (single-language, flat or combined), `../sql` when the project is multi-language and each lane nests one dir below the shared `sql/` tree. `combined` prefixes both lane and shared tree with `backend/`, so it cancels and only `multiLanguage` matters. Settings-driven via the wrapped names — the single source for the host `--migrate-path`. */
  migrateRoot(): string {
    return this.names.multiLanguage ? "../sql" : "sql";
  }

  /** The dialect's migrations dir relative to the lane: `sql/<dialect>/migrations` or `../sql/<dialect>/migrations`. */
  migrationsPath(dialect: string): string {
    return `${this.migrateRoot()}/${dialect}/migrations`;
  }

  /** The container's sql root (`/app/sql`) — the decoupled `CONTAINER_SQL_ROOT` constant, independent of the host lane→shared depth `migrationsPath` resolves. */
  containerSqlRoot(): string {
    return CONTAINER_SQL_ROOT;
  }

  /** The dialect's migrations dir inside the container: `/app/sql/<dialect>/migrations`, read absolute by the entrypoint and the docker-run pretest regardless of `multiLanguage`. */
  containerMigrationsDir(dialect: string): string {
    return `${this.containerSqlRoot()}/${dialect}/migrations`;
  }

  /** The Dockerfile `COPY` source prefixes (build context = project root, so root-relative — a different frame from `migrateRoot`'s lane-relative host path). `lane` reaches this lane's subtree (`<lang>/`, `backend/<lang>/`); `shared` reaches the backend-shared `sql/` tree, which never carries a `<lang>/` segment. `combined` is the per-generate tier flag (`tier === "all"`), passed in rather than re-derived from settings since `--tier` can override it. The single source for the container frame — generators must not recompute these from `backendLaneDir`. */
  migrateDockerCopyPrefixes({
    combined = false,
  }: { combined?: boolean } = {}): {
    lane: string;
    shared: string;
  } {
    const language = this.names.language;
    return {
      lane: backendLaneDir({
        combined,
        multiLanguage: this.names.multiLanguage,
        language,
      }),
      shared: backendLaneDir({ combined, multiLanguage: false, language }),
    };
  }

  /** The language's colocated-test subdirectory: `tests/` for rust (Cargo unit-test convention), `__tests__/` for everyone else. Placement, so it lives here rather than in each generator. */
  testColocationDir(): string {
    return this.names.language === "rust" ? "tests" : "__tests__";
  }

  /** Placement dir for a language-level shared file that is NOT entity-scoped (e.g. an ambient `db-driver-shims.d.ts`): the `features/` root under by-feature, else the flat `types/` base. Layout owns this so generators don't branch on `byFeature` themselves. */
  sharedDir(): string {
    return this.names.byFeature ? "features" : "types";
  }

  /** Generated path for a colocated test file; the caller owns `fileName` (the `.test`/`_test` suffix baked on). Flat returns the bare name (the step's `outputDir` supplies the tests dir); by-feature nests it at `features/<dir>/<testColocationDir>/<fileName>`. Resolving `byFeature` is the layout's job. */
  testPath(
    entity: string,
    artifact: string,
    { fileName }: { fileName: string },
  ): string {
    if (!this.names.byFeature) return fileName;
    return this.featurePath(
      entity,
      artifact,
      `${this.testColocationDir()}/${fileName}`,
    );
  }

  /** Import specifier from a colocated test file to a sibling artifact in the same feature — one `../` deeper than `importSpecifier`, since the test lives in the `testColocationDir` subdir. Flat mode returns `flat` unchanged (the legacy `../validators/x` layout is outside the feature graph). */
  testImportSpecifier(
    from: ArtifactRef,
    to: ArtifactRef,
    { flat }: { flat: string },
  ): string {
    if (!this.names.byFeature) return flat;
    const spec = this.importSpecifier(from, to);
    return `../${spec.replace(/^\.\//, "")}`;
  }

  /** The generated frontend bindings root: every frontend-tier artifact lives under this tree, one datasource subdir per `frontend_bindings.yaml` entry. */
  frontendRoot(): string {
    return posix.join("frontend", "src", "bindings");
  }

  /** The datasource-scoped bindings dir `bindings/<datasource>` — casing flows through the wrapped names' `casedFileStem`, so it honors `fileFormat`. */
  frontendDatasourceDir(datasource: string): string {
    return posix.join(
      this.frontendRoot(),
      this.names.casedFileStem(datasource),
    );
  }

  /** The datasource's shared read-type dir `bindings/<datasource>/types` — the datasource is the type-sharing boundary, so every object's entity + view types live here in BOTH layout modes (types are many-to-many with objects — views and nested types have no owning object — so they stay shared rather than slicing per feature). */
  frontendTypesDir(datasource: string): string {
    return posix.join(this.frontendDatasourceDir(datasource), "types");
  }

  /** A file under the shared `types/` dir; the caller owns the leaf (`<stem>.ts`, `<stem>.test.ts`, `index.ts`). Stem casing flows through the wrapped names at the call site. */
  frontendTypesFile(datasource: string, leaf: string): string {
    return posix.join(this.frontendTypesDir(datasource), leaf);
  }

  /** An object's vertical-slice dir `bindings/<datasource>/features/<object>` — under by-feature it holds that object's client + `validators.ts`; read types stay in the shared `types/` dir. */
  frontendFeatureDir(datasource: string, object: string): string {
    return posix.join(
      this.frontendDatasourceDir(datasource),
      "features",
      this.names.casedFileStem(object),
    );
  }

  /** A client library file for `file` (`fetch.ts`, `axios.test.ts`, `fetch.bindings.live.ts`). Flat: `clients/<object>.<file>` (object folded into the filename). By-feature: `features/<object>/<file>` (colocated in the slice). */
  frontendClientFile(datasource: string, object: string, file: string): string {
    if (this.names.byFeature) {
      return posix.join(this.frontendFeatureDir(datasource, object), file);
    }
    return posix.join(
      this.frontendDatasourceDir(datasource),
      "clients",
      `${this.names.casedFileStem(object)}.${file}`,
    );
  }

  /** An object's validators file. Flat: `validators/<object>.ts` (or `.test.ts`). By-feature: `features/<object>/validators.ts` (or `validators.test.ts`). */
  frontendValidatorFile(
    datasource: string,
    object: string,
    { test = false }: { test?: boolean } = {},
  ): string {
    if (this.names.byFeature) {
      return posix.join(
        this.frontendFeatureDir(datasource, object),
        test ? "validators.test.ts" : "validators.ts",
      );
    }
    return posix.join(
      this.frontendDatasourceDir(datasource),
      "validators",
      `${this.names.casedFileStem(object)}${test ? ".test" : ""}.ts`,
    );
  }

  /** The specifier a client uses to import its datasource's shared read-type barrel — `../types` from a flat `clients/` file, `../../types` from a by-feature `features/<object>/` file (the barrel is shared in both modes; only the client's depth differs). */
  frontendTypesImport(_datasource: string): string {
    return this.names.byFeature ? "../../types" : "../types";
  }

  /** The relative import specifier (extension omitted) from one placed frontend file to another — the single primitive for every cross-file frontend import (client→validators, test→subject, live-test→sibling client, type→sibling type). Generators compose both endpoints from the placement methods, so both layout modes fall out of `posix.relative` with no per-purpose branching. */
  frontendRelImport(fromFile: string, toFile: string): string {
    const toNoExt = toFile.slice(0, -this.names.ext.length);
    const rel = posix.relative(posix.dirname(fromFile), toNoExt);
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  /** Import specifier (extension omitted) from `from`'s file to `to`'s file — flat vs by-feature resolved from settings on `names`. `targetSubdir` nests the target (custom services live under `custom/`). */
  importSpecifier(
    from: ArtifactRef,
    to: ArtifactRef,
    { targetSubdir }: { targetSubdir?: string } = {},
  ): string {
    const { names } = this;
    if (!names.byFeature) {
      const fromDir = posix.dirname(this.srcPath(from.entity, from.artifact));
      const toPath = this.srcPath(to.entity, to.artifact);
      const toNoExt = toPath.slice(0, -names.ext.length);
      const rel = posix.relative(fromDir, toNoExt);
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
    const fromDir = this.featureDir(from.entity, from.artifact);
    const toDir = this.featureDir(to.entity, to.artifact);
    const toBase = `${names.fileBase(to.entity, to.artifact)}${names.bfRoleExt(to.artifact)}`;
    const seg = targetSubdir ? `${targetSubdir}/${toBase}` : toBase;
    return fromDir === toDir ? `./${seg}` : `../${toDir}/${seg}`;
  }
}
