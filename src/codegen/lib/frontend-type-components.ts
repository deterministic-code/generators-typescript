import { parse } from "yaml";
import { parseDatasourceTypes } from "../../sdk/codegen/lib/parse-datasource-types.ts";
import { CodegenFieldNames } from "../../sdk/field-names.ts";
import { buildComponents } from "../../sdk/lib/schema-build.ts";
import { namesForSettings } from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { datetimeOptionFromSettings } from "../../sdk/codegen/lib/generate-settings-options.ts";
import type { RawTypesDoc } from "../../sdk/deterministic-shapes.ts";
import type { GenerateArgs } from "./frontend-generate-types.ts";

interface FrontendComponentsInputs {
  all(): Promise<{ viewYamlText: string; datasourceYamlText: string }>;
}

/** The shared setup frontend_types and its test generator both start from: parse the view + datasource YAML, build the OpenAPI component oracle, and resolve the settings-driven name/field casing + datetime representation. Returns `{ components, names, fields, datetime }` so both derive the read-type surface one way and can't drift. */
export async function buildFrontendComponents({ inputs, settings }: GenerateArgs) {
  const { viewYamlText, datasourceYamlText } = await (
    inputs as FrontendComponentsInputs
  ).all();
  const viewData: RawTypesDoc = parse(viewYamlText);
  const datasourceData: RawTypesDoc = datasourceYamlText
    ? (parseDatasourceTypes(datasourceYamlText, settings) as RawTypesDoc)
    : { types: [] };
  const components = buildComponents(viewData, datasourceData);
  const names = namesForSettings(settings, "typescript");
  const fields = new CodegenFieldNames({ fieldFormat: names.fieldFormat });
  return {
    components,
    names,
    fields,
    datetime: datetimeOptionFromSettings(settings).datetime,
  };
}
