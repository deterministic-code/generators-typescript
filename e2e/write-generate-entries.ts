import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Patch, PatchMerger } from "@deterministic-code/patch-merger";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";

type PatchEntry = Extract<GenerateEntry, { kind: "patch" }> & {
  appendIfNotExists?: "None" | "End" | "Start";
};

const asPatch = (entry: PatchEntry): Patch => {
  if (entry.section === undefined) {
    return new Patch({ target: entry.filename, content: entry.content });
  }
  return new Patch({
    target: entry.filename,
    content: entry.content,
    options: {
      sections: [entry.section],
      ...(entry.appendIfNotExists === undefined
        ? {}
        : { appendIfNotExists: entry.appendIfNotExists }),
    },
  });
};

export const writeGenerateEntries = async (
  rootDir: string,
  entries: GenerateEntry[],
): Promise<void> => {
  const merger = new PatchMerger();
  const patches: Extract<GenerateEntry, { kind: "patch" }>[] = [];
  for (const entry of entries) {
    if (entry.kind === "content") {
      const path = join(rootDir, entry.filename);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.contents, "utf8");
      continue;
    }
    patches.push(entry);
  }
  const byFile = new Map<string, Extract<GenerateEntry, { kind: "patch" }>[]>();
  for (const entry of patches) {
    const list = byFile.get(entry.filename);
    if (list === undefined) byFile.set(entry.filename, [entry]);
    else list.push(entry);
  }
  for (const [filename, filePatches] of byFile) {
    const hasSeed = filePatches.some((entry) => entry.section === undefined);
    if (!hasSeed) {
      const existing = await readFile(join(rootDir, filename), "utf8").catch(
        () => null,
      );
      if (existing !== null && existing.length > 0) {
        merger.add(new Patch({ target: filename, content: existing }));
      }
    }
    for (const entry of filePatches) merger.add(asPatch(entry));
  }
  const written = await merger.apply(rootDir);
  await Promise.all(
    written
      .filter((target) => target.endsWith(".sh"))
      .map((target) => chmod(join(rootDir, target), 0o755)),
  );
};
