/** The two entry kinds every generator returns: a whole file, or a shared-file patch block. */
export const CONTENT = "content";
export const PATCH = "patch";

/** A whole-file `content` entry or a shared-file `patch` entry — the union an generator's `entries` array holds. `kind` stays `string` because generators read it off the widened `CONTENT`/`PATCH` constants; `assertEntry` narrows and validates the exact key-set at the boundary. */
export type GenerateEntry =
  | { kind: string; filename: string; contents: unknown }
  | {
      kind: string;
      filename: string;
      content: string;
      section?: string;
      path?: string;
    };

interface FileLike {
  path: string;
  content: string;
}

/** The empty generate result a create-script returns when validation fails: no files, no resolved language/organize, carrying the failed `validation` for the caller to surface. */
export function emptyGenerateResult(validation: unknown) {
  return { files: [], language: null, organize: null, validation };
}

/** Adapt a legacy `File[]` (`{path, content}`) into `content` entries; provider routing is derived from the filename, so no `kind` axis is carried. */
export function entriesFromFiles(files: FileLike[]) {
  return files.map((f) => ({
    kind: CONTENT,
    filename: f.path,
    contents: f.content,
  }));
}

/** Adapt a scaffold `File[]` into entries, generating the composed-skeleton targets (`isSkeletonTarget(path)` — Cargo.toml / Dockerfile / entrypoint / *.csproj that migrate & perf fill) as `patch` pieces and everything else as whole-file `content`. */
export function skeletonEntriesFromFiles(
  files: FileLike[],
  isSkeletonTarget: (path: string) => boolean,
) {
  return files.map((f) =>
    isSkeletonTarget(f.path)
      ? { kind: PATCH, filename: f.path, content: f.content }
      : { kind: CONTENT, filename: f.path, contents: f.content },
  );
}

// The FROZEN generate-entry shape. An generator hands over dumb, self-identifying data — no field the patcher selects on (no method / language / markers). Adding a key here is a deliberate contract change; the closed key-set below + interface-frozen.yaml (EntryTypes) both reject drift so patcher logic can't leak onto the entry.
const CONTENT_ENTRY_KEYS = new Set(["kind", "filename", "contents"]);
const PATCH_ENTRY_KEYS = new Set([
  "kind",
  "filename",
  "content",
  "section",
  "path",
]);

/** Guard the entry contract: a whole-file `content` (`{kind, filename, contents}`) or a shared-file `patch` (`{kind, filename, content, section?}`) — and NOTHING else. Any unknown key throws. */
export function assertEntry(entry: Record<string, unknown>) {
  if (entry.kind !== CONTENT && entry.kind !== PATCH) {
    throw new Error(`generate entry: unknown kind ${JSON.stringify(entry.kind)}`);
  }
  const allowed =
    entry.kind === CONTENT ? CONTENT_ENTRY_KEYS : PATCH_ENTRY_KEYS;
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) {
      throw new Error(
        `generate ${entry.kind} entry: unexpected key "${key}" — the entry shape is frozen to {${[...allowed].join(", ")}}`,
      );
    }
  }
  if (typeof entry.filename !== "string" || entry.filename.length === 0) {
    throw new Error(
      `generate ${entry.kind} entry: filename must be a non-empty string`,
    );
  }
}
