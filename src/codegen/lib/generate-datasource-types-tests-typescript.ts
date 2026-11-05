import { createGenerator } from "./generate-datasource-tests-typescript.ts";
import { makeDatasourceGenerate } from "../../sdk/codegen/lib/datasource-generate-config.ts";

/** Self-describing generate for the typescript datasource-type tests — wraps the shared `generate-datasource-tests-typescript` render via `makeDatasourceGenerate`. */
export const generate = makeDatasourceGenerate(createGenerator, "typescript");
