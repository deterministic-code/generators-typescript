import type { ParsedSettings } from "../../read-settings.ts";
/** Types shared by the three `generate-service-tests-<language>` generators. */

export interface GeneratedFile {
  path: string;
  content: string;
}

/** The `createGenerator().generate(config)` payload the shared `services-generate` step passes through — every field is opaque here and typed downstream. */
export interface ServiceTestsGenerateConfig {
  services: unknown;
  viewTypes: unknown;
  datasourceTypes: unknown;
  routes: unknown;
  settings: ParsedSettings;
  language: unknown;
}
