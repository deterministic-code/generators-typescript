import { parse } from "yaml";
import { materializeReferenceTypes } from "../../datasource-references.ts";
import type { RawTypesDoc } from "../../deterministic-shapes.ts";
import { hydrateSeeds } from "./parse-datasource-types.ts";

type DatasourceTypesInput = Parameters<typeof materializeReferenceTypes>[0];

interface RequireYamlContext {
  argName: string;
  fileName: string;
  context: string;
}

interface ViewAndDatasourceArgs {
  viewYamlText?: string;
  datasourceYamlText?: string;
  datasourceSeedsYamlText?: string | null;
  context: string;
  idType: string;
}

interface ViewAndDatasource {
  viewData: RawTypesDoc;
  datasourceData: ReturnType<typeof materializeReferenceTypes>;
}

function requireYaml(
  text: string | undefined,
  { argName, fileName, context }: RequireYamlContext,
): asserts text is string {
  if (!text) {
    throw new Error(`${context} expansion requires ${argName} (${fileName}).`);
  }
}

/** Parse the view + datasource sibling YAML every services/routes create-script needs — materialize type-less references and fold the companion seeds onto the datasource. Schema validation is the specifications repo's job; this parses only. */
export async function validateViewAndDatasource({
  viewYamlText,
  datasourceYamlText,
  datasourceSeedsYamlText,
  context,
  idType,
}: ViewAndDatasourceArgs): Promise<ViewAndDatasource> {
  requireYaml(viewYamlText, {
    argName: "viewYamlText",
    fileName: "view_types.yaml",
    context,
  });
  requireYaml(datasourceYamlText, {
    argName: "datasourceYamlText",
    fileName: "datasource_types.yaml",
    context,
  });
  return {
    viewData: parse(viewYamlText) as RawTypesDoc,
    datasourceData: hydrateSeeds(
      materializeReferenceTypes(
        parse(datasourceYamlText) as DatasourceTypesInput,
        idType,
      ),
      datasourceSeedsYamlText,
    ),
  };
}
