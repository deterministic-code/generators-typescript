import {
  loadFieldTypeCatalog,
  languageTypeMap,
} from "../../lib/field-type-catalog.ts";
import { CONVERTER_MODULES } from "../../lib/field-converter.ts";

const CATALOG = await loadFieldTypeCatalog();
const MODULES = CONVERTER_MODULES;

export function createTypeMapper(language: string) {
  const mod = MODULES[language];
  if (!mod || mod.targetKind !== "language") {
    throw new Error(`createTypeMapper: unsupported language '${language}'`);
  }
  const stringDatetime = mod.datetimeStringType as string;
  const byAbstract = languageTypeMap(CATALOG, language);
  return function mapType(
    dsType: string,
    { datetime = "native" }: { datetime?: string } = {},
  ): string {
    if (dsType === "datetime" && datetime === "string") return stringDatetime;
    const mapped = byAbstract.get(dsType);
    if (mapped === undefined) {
      throw new Error(`Unknown field type: ${dsType}`);
    }
    return mapped;
  };
}
