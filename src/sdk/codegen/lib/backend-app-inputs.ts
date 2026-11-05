import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { pathExists } from "../../path-exists.ts";
import { materializeReferenceTypes } from "../../datasource-references.ts";
import { idTypeFromSettings } from "./ts-datasource-settings.ts";

/** Parse the five `deterministic/` input YAMLs a backend_app generator reads to build its app model; a missing file is an empty doc (a minimal scaffold defines no routes/services). The datasource doc is embedded verbatim into the generated app and consumed by the runtime (zod schema build, CRUD specs), so type-less references are materialized to their parent-PK type here — the same parse boundary the codegen generators use. Shared so every language generator reads inputs identically. */
export async function loadBackendAppInputs(
  inputDir: string,
  settings: unknown,
) {
  const load = async (name: string) => {
    const p = join(inputDir, name);
    return (await pathExists(p)) ? yamlLoad(await readFile(p, "utf8")) : {};
  };
  return {
    backendAppConfig: await load("backend-app.yaml"),
    routesDoc: await load("routes.yaml"),
    servicesDoc: await load("services.yaml"),
    viewTypesDoc: await load("view_types.yaml"),
    datasourceTypesDoc: materializeReferenceTypes(
      (await load("datasource_types.yaml")) as Parameters<
        typeof materializeReferenceTypes
      >[0],
      idTypeFromSettings(
        settings as Parameters<typeof idTypeFromSettings>[0],
      ) as Parameters<typeof materializeReferenceTypes>[1],
    ),
  };
}
