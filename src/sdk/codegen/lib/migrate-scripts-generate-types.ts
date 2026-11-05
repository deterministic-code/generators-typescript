import type { CodegenLayout } from "../../codegen-layout.ts";
import { resolveLibraryReferenceMode } from "../../read-settings.ts";
import { layoutForSettings } from "./ts-codegen-naming.ts";

/** A whole-file CONTENT generate entry. `kind` is the runtime `CONTENT` tag, typed as `string` because the generate-result const widens through the object literal. */
export interface ContentEntry {
  kind: string;
  filename: string;
  contents: string;
}

/** A shared-file PATCH generate entry; `section` names a marked block when present, absent for a seed/whole-content patch. */
export interface PatchEntry {
  kind: string;
  filename: string;
  content: string;
  section?: string;
}

/** The two entry kinds every migrate generator returns — a whole file or a shared-file patch block. */
export type MigrateEntry = ContentEntry | PatchEntry;

/** The loader-resolved settings a migrate render fn threads into layout + library-mode resolution — `CodegenNames`' settings plus the top-level `languages` map `resolveLibraryReferenceMode` reads. */
type MigrateSettings = Parameters<typeof layoutForSettings>[0] & {
  languages?: Parameters<typeof resolveLibraryReferenceMode>[0];
};

/** The `CodegenLayout` a migrate render fn derives once from settings and passes to its path/package helpers. */
export type MigrateLayout = CodegenLayout;

/** The options object every language's whole-scaffold render fn receives from `makeMigrateGenerate`. */
export interface MigrateRenderOptions {
  migrateDir: string;
  dialects?: string[];
  inputs: { dir: string };
  settings: MigrateSettings;
  combined: boolean;
}
