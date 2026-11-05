import type { ParsedSettings } from "../../read-settings.ts";
/** A single generated source file: output-relative path plus full contents. Shared by every language routes generator. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** The `createGenerator().generate(config)` payload the routes step hands each language generator before it folds in language-specific primitives. */
export interface RoutesGenerateConfig {
  services: unknown;
  viewTypes: unknown;
  datasourceTypes: unknown;
  routes: unknown;
  settings: ParsedSettings;
  language: unknown;
}
