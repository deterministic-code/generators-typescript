/** The migration sequence numbering used at codegen time. The initial schema migration is sequence 1 (`0001_initial`); anything generated after it (stored procedures) is the next sequence. The runtime file-scan equivalent (highest `NNNN_` prefix + 1) lives in the generated `migrate-create` CLI — same `pad4` scheme, applied to a live directory instead of the known baseline. */

export const INITIAL_MIGRATION_SEQUENCE = 1;

export function migrationStem(sequence: number, name: string): string {
  return `${String(sequence).padStart(4, "0")}_${name}`;
}
