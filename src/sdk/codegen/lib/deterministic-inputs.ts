import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { pathExists } from "../../path-exists.ts";
import { resolveIncludes } from "../../lib/datasource-types-includes.ts";
import { combinedLoader } from "../../lib/datasource-types-include-loaders.ts";
import {
  fileIdIncludes,
  resolveViewIncludes,
} from "../../lib/view-types-includes.ts";
import { combinedLoader as viewCombinedLoader } from "../../lib/view-types-include-loaders.ts";
import { resolveServicesIncludes } from "../../lib/services-includes.ts";
import { combinedLoader as servicesCombinedLoader } from "../../lib/services-include-loaders.ts";
import { resolveRoutesIncludes } from "../../lib/routes-includes.ts";
import { combinedLoader as routesCombinedLoader } from "../../lib/routes-include-loaders.ts";
import { mergeCustomMigrations } from "../../lib/custom-migrations-merge.ts";
import { readConfigApiUrl } from "../../lib/deterministic-config.ts";
import type {
  RawIncludeEntry,
  RawTypesDoc,
} from "../../deterministic-shapes.ts";
import type { CustomMigrationPair } from "../../lib/custom-migrations-manifest.ts";

type CustomMigrations = Record<string, CustomMigrationPair[]>;

interface StandardInputTexts {
  routesYamlText: string | null;
  viewYamlText: string | null;
  datasourceYamlText: string | null;
  datasourceSeedsYamlText: string | null;
  servicesYamlText: string | null;
}

type StandardInputKey = keyof StandardInputTexts;

interface DeterministicInputsResult extends StandardInputTexts {
  includedCustomMigrations: CustomMigrations;
}

interface StepInput extends Partial<StandardInputTexts> {
  deterministicDir?: string;
}

type ResolvedStepInputs = Partial<
  Record<StandardInputKey, string | null | undefined>
>;

interface DatasourceResolution {
  yaml: string | null;
  customMigrations: CustomMigrations;
}

interface ViewResolution {
  viewYaml: string | null;
  datasourceYaml: string | null;
  customMigrations: CustomMigrations;
}

interface SiblingResolution {
  yaml: string | null;
  datasourceYaml: string | null;
  customMigrations: CustomMigrations;
}

interface SiblingOpts {
  datasourceYaml: string | null;
  loaderFactory: typeof servicesCombinedLoader;
  resolveFn: typeof resolveServicesIncludes;
}

interface IncludedResolutions {
  resolved: DatasourceResolution;
  view: ViewResolution;
  services: SiblingResolution;
  routes: SiblingResolution;
}

/** The `includes:` list of a YAML text, or null when the text is absent or unparseable (left for the downstream validator to report with line positions). */
function includesOf(text: string | null | undefined): RawIncludeEntry[] | null {
  if (text == null) return null;
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  const js = doc.toJS() as RawTypesDoc | null;
  const includes = js?.includes;
  return Array.isArray(includes) ? includes : [];
}

async function loaderApiUrl(): Promise<string | null> {
  return process.env.DETERMINISTIC_API_URL ?? (await readConfigApiUrl());
}

/** Expand a datasource_types text's `includes:` (if any) into a merged document plus the included datasources' carried custom migrations. Malformed YAML is returned untouched so the downstream validator reports it with line positions. */
async function resolveDatasourceIncludes(
  dir: string,
  text: string | null,
): Promise<DatasourceResolution> {
  const includes = includesOf(text);
  if (text == null || !includes || includes.length === 0) {
    return { yaml: text, customMigrations: {} };
  }
  const load = combinedLoader({ apiUrl: await loaderApiUrl() });
  const resolved = await resolveIncludes(
    text,
    load as Parameters<typeof resolveIncludes>[1],
    { baseDir: dir },
  );
  return { yaml: resolved.yaml, customMigrations: resolved.customMigrations };
}

/** Fold a view_types text's `file:`/`id:` includes, combining each include's datasource onto the project's merged datasource (so `inherits`/references validate and the inherited tables land in the generated datasource). Returns the merged view, the combined datasource, and the included datasources' custom migrations. No `file:`/`id:` includes → the inputs pass through unchanged. */
async function resolveViewTypeIncludes(
  dir: string,
  text: string | null,
  datasourceYamlText: string | null,
): Promise<ViewResolution> {
  const includes = includesOf(text);
  if (text == null || !includes || fileIdIncludes(includes).length === 0) {
    return {
      viewYaml: text,
      datasourceYaml: datasourceYamlText,
      customMigrations: {},
    };
  }
  const load = viewCombinedLoader({ apiUrl: await loaderApiUrl() });
  const resolved = await resolveViewIncludes(
    text,
    load as Parameters<typeof resolveViewIncludes>[1],
    { baseDir: dir, datasourceYaml: datasourceYamlText },
  );
  return {
    viewYaml: resolved.yaml,
    datasourceYaml: resolved.datasourceYaml ?? datasourceYamlText,
    customMigrations: resolved.customMigrations,
  };
}

/** Fold a flat-artifact text's (services / routes) `file:`/`id:` includes, combining each `id:` include's datasource onto the (already view-merged) project datasource so the merged entries' references have their tables at generate. Returns the merged text, the combined datasource, and the included datasources' custom migrations. No `file:`/`id:` includes → the inputs pass through unchanged. */
async function resolveSiblingIncludes(
  dir: string,
  text: string | null,
  opts: SiblingOpts,
): Promise<SiblingResolution> {
  const { datasourceYaml, loaderFactory, resolveFn } = opts;
  const includes = includesOf(text);
  if (text == null || !includes || fileIdIncludes(includes).length === 0) {
    return { yaml: text, datasourceYaml, customMigrations: {} };
  }
  const load = loaderFactory({ apiUrl: await loaderApiUrl() });
  const resolved = await resolveFn(
    text,
    load as Parameters<typeof resolveFn>[1],
    { baseDir: dir, datasourceYaml },
  );
  return {
    yaml: resolved.yaml,
    datasourceYaml: resolved.datasourceYaml ?? datasourceYaml,
    customMigrations: resolved.customMigrations,
  };
}

const STANDARD_INPUTS: Record<StandardInputKey, string> = {
  routesYamlText: "routes.yaml",
  viewYamlText: "view_types.yaml",
  datasourceYamlText: "datasource_types.yaml",
  datasourceSeedsYamlText: "datasource_seeds.yaml",
  servicesYamlText: "services.yaml",
};

const cache = new Map<string, DeterministicInputs>();

async function readInputText(
  dir: string,
  file: string,
): Promise<string | null> {
  const path = join(dir, file);
  return (await pathExists(path)) ? readFile(path, "utf8") : null;
}

async function readStandardInputs(dir: string): Promise<StandardInputTexts> {
  const keys = Object.keys(STANDARD_INPUTS) as StandardInputKey[];
  const texts = await Promise.all(
    keys.map((key) => readInputText(dir, STANDARD_INPUTS[key])),
  );
  const out = {} as StandardInputTexts;
  keys.forEach((key, i) => {
    out[key] = texts[i];
  });
  return out;
}

function mergeIncludedMigrations({
  resolved,
  view,
  services,
  routes,
}: IncludedResolutions): CustomMigrations {
  let migrations = mergeCustomMigrations(
    { ...resolved.customMigrations },
    view.customMigrations,
    "view_includes",
  );
  migrations = mergeCustomMigrations(
    migrations,
    services.customMigrations,
    "services_includes",
  );
  return mergeCustomMigrations(
    migrations,
    routes.customMigrations,
    "routes_includes",
  );
}

/** The standard input YAMLs of one `deterministic/` folder, read once. The folder is static per deploy, so `for(dir)` returns a per-dir singleton and `all()` memoizes the read — repeated steps and the per-language generate loop share it. A missing file resolves to `null`. */
export class DeterministicInputs {
  readonly dir: string;
  _all: Promise<DeterministicInputsResult> | null;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this._all = null;
  }

  static for(dir: string): DeterministicInputs {
    const resolved = resolve(dir);
    let inst = cache.get(resolved);
    if (!inst) {
      inst = new DeterministicInputs(resolved);
      cache.set(resolved, inst);
    }
    return inst;
  }

  async all(): Promise<DeterministicInputsResult> {
    if (!this._all) this._all = this.#read();
    return this._all;
  }

  async #read(): Promise<DeterministicInputsResult> {
    const out: DeterministicInputsResult = {
      ...(await readStandardInputs(this.dir)),
      includedCustomMigrations: {},
    };
    const resolved = await resolveDatasourceIncludes(
      this.dir,
      out.datasourceYamlText,
    );
    out.datasourceYamlText = resolved.yaml;
    const view = await resolveViewTypeIncludes(
      this.dir,
      out.viewYamlText,
      out.datasourceYamlText,
    );
    out.viewYamlText = view.viewYaml;
    out.datasourceYamlText = view.datasourceYaml;
    const services = await resolveSiblingIncludes(
      this.dir,
      out.servicesYamlText,
      {
        datasourceYaml: out.datasourceYamlText,
        loaderFactory: servicesCombinedLoader,
        resolveFn: resolveServicesIncludes,
      },
    );
    out.servicesYamlText = services.yaml;
    out.datasourceYamlText = services.datasourceYaml;
    const routes = await resolveSiblingIncludes(this.dir, out.routesYamlText, {
      datasourceYaml: out.datasourceYamlText,
      loaderFactory: routesCombinedLoader,
      resolveFn: resolveRoutesIncludes,
    });
    out.routesYamlText = routes.yaml;
    out.datasourceYamlText = routes.datasourceYaml;
    out.includedCustomMigrations = mergeIncludedMigrations({
      resolved,
      view,
      services,
      routes,
    });
    return out;
  }

  /** Resolve the named sibling-input texts an generator needs from this folder. An explicitly-passed text still wins over the folder copy. A key with no source stays `undefined` so the generator's required-input guard throws. */
  async resolve(
    input: StepInput,
    keys: StandardInputKey[],
  ): Promise<ResolvedStepInputs> {
    const missing = keys.some((key) => input[key] == null);
    const loaded: Partial<DeterministicInputsResult> = missing
      ? await this.all()
      : {};
    const out: ResolvedStepInputs = {};
    for (const key of keys) out[key] = input[key] ?? loaded[key];
    return out;
  }
}

/** Resolve an generate step's sibling-input texts. With a `deterministicDir`, read them (once, cached) from that folder; without one — the unit path, where generate is handed its texts directly — keep only what was passed. */
export async function resolveStepInputs(
  input: StepInput,
  keys: StandardInputKey[],
): Promise<ResolvedStepInputs> {
  if (!input.deterministicDir) {
    const out: ResolvedStepInputs = {};
    for (const key of keys) out[key] = input[key];
    return out;
  }
  return DeterministicInputs.for(input.deterministicDir).resolve(input, keys);
}
