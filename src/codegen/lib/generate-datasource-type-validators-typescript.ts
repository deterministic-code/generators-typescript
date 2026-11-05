import { createGenerator } from "./generate-datasource-validator-typescript.ts";
import { makeDatasourceGenerate } from "../../sdk/codegen/lib/datasource-generate-config.ts";

/** Self-describing generate for the typescript datasource-type validators — wraps the shared `generate-datasource-validator-typescript` render via `makeDatasourceGenerate`. */
export const generate = makeDatasourceGenerate(createGenerator, "typescript");
