import { toCase, type CaseFormat } from "./case.ts";
import { safeIdent } from "./generator-shared.ts";

/** Casing-aware deriver of field/member identifiers (fieldFormat), plus safe-identifier quoting for generated object keys. Class/file names live in `CodegenNames`; placement in `CodegenLayout`. */
export class CodegenFieldNames {
  fieldFormat: CaseFormat;

  constructor({ fieldFormat }: { fieldFormat: CaseFormat }) {
    this.fieldFormat = fieldFormat;
  }

  /** The cased field/member name for a column. */
  name(field: string): string {
    return toCase(field, this.fieldFormat);
  }

  /** The cased name as a safe object-key identifier (quoted when not a bare identifier). */
  ident(field: string): string {
    return safeIdent(this.name(field));
  }
}
