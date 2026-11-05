import { MarkedFileEditor } from "@deterministic-code/patch-merger";
import type {
  PatchMarkedBlockArgs,
  EnsureLinesInMarkedBlockArgs,
} from "@deterministic-code/patch-merger";
import { writeFileCanonical } from "./write-file-canonical.ts";

// Binds the manifest-aware canonical writer every codegen generator needs. MarkedFileEditor's methods carry no per-call state, so one shared instance is safe.
const canonical = new MarkedFileEditor({
  writeTextFile: (path: string, content: string) =>
    writeFileCanonical(path, content, "utf8"),
});

export function patchMarkedBlock(opts: PatchMarkedBlockArgs): Promise<boolean> {
  return canonical.patchMarkedBlock(opts);
}

export function ensureLinesInMarkedBlock(
  opts: EnsureLinesInMarkedBlockArgs,
): Promise<boolean> {
  return canonical.ensureLinesInMarkedBlock(opts);
}
