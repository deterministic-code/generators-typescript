import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  content,
  patch,
} from "@deterministic-code/generators-common/generate-entry";
import { writeGenerateEntries } from "../e2e/write-generate-entries.ts";

describe("writeGenerateEntries", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "write-entries-"));
    dirs.push(dir);
    return dir;
  };

  it("lets an unsectioned patch replace content for the same file", async () => {
    const dir = await scratch();
    await writeGenerateEntries(dir, [
      content("app.ts", "minimal\n"),
      patch("app.ts", "deterministic\n"),
    ]);
    assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "deterministic\n");
  });

  it("applies a section patch onto content when there is no seed patch", async () => {
    const dir = await scratch();
    await writeGenerateEntries(dir, [
      content("app.ts", "// === BEGIN HOOK ===\n// === END HOOK ===\n"),
      patch("app.ts", "wired\n", "HOOK"),
    ]);
    const body = await readFile(join(dir, "app.ts"), "utf8");
    assert.match(body, /wired/);
    assert.match(body, /BEGIN HOOK/);
  });

  it("throws when appendIfNotExists is None and the section is missing", async () => {
    const dir = await scratch();
    const hook = patch("app.ts", "enableMiddleware: [],\n", "APP_BEFORE_HOOK");
    Object.assign(hook, { appendIfNotExists: "None" });
    await assert.rejects(
      () =>
        writeGenerateEntries(dir, [
          content("app.ts", "export const createBackendApp = async () => {};\n"),
          hook,
        ]),
      /section "APP_BEFORE_HOOK" does not exist/,
    );
  });

  it("composes a seed patch plus a section patch", async () => {
    const dir = await scratch();
    await writeGenerateEntries(dir, [
      content("app.ts", "minimal\n"),
      patch("app.ts", "// === BEGIN HOOK ===\n// === END HOOK ===\n"),
      patch("app.ts", "wired\n", "HOOK"),
    ]);
    const body = await readFile(join(dir, "app.ts"), "utf8");
    assert.match(body, /wired/);
    assert.doesNotMatch(body, /minimal/);
  });
});
