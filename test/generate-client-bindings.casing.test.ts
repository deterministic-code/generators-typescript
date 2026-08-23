import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { createCasing } from "../src/common/default-casing.ts";
import { generate } from "../src/generate-client-bindings.ts";

const yaml = {
  "types.yaml": `types:
  - contact_source:
      tags: [datasource_type, view_type, readonly_lookup]
      inherits: set
      fields:
        - name:
            type: string
`,
  "routes.yaml": `includes:
  - types:
      filter: 'tag == "view_type" || tag == "datasource_type"'
`,
};

const ctx = (settings: Record<string, string>) => ({
  reader: memoryReader(yaml),
  settings,
});

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(
    hit,
    `missing entry ${path}; got ${entries.map((e) => e.filename).join(", ")}`,
  );
  assert.equal(hit.kind, "content");
  return hit.contents;
};

const fetchPath = (fileBase: string): string =>
  `frontend/src/client/fetch/${fileBase}.ts`;

const assertClientNames = (
  fetchBody: string,
  tanstackBody: string,
  settings: Record<string, string>,
  entity: string,
): void => {
  const casing = createCasing(settings);
  const clientName = casing.clientName(entity);
  const queryOptions = casing.clientQueryOptionsName(entity);
  const mutationOptions = casing.clientMutationOptionsName(entity);
  const hookName = casing.hookName(entity, "list");
  assert.match(fetchBody, new RegExp(`export const ${clientName}`));
  assert.match(tanstackBody, new RegExp(`export const ${queryOptions}`));
  assert.match(tanstackBody, new RegExp(`export const ${mutationOptions}`));
  assert.match(tanstackBody, new RegExp(`export const ${hookName}`));
  assert.match(tanstackBody, new RegExp(`import \\{ ${clientName} \\}`));
};

describe("generate client bindings casing", () => {
  it("Auto uses Camel files and convertTypes client factories", async () => {
    const settings = {};
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("contactSource"));
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/contactSource.ts",
    );
    assertClientNames(body, tanstack, settings, "contact_source");
    assert.match(body, /export const ContactSourceClient/);
    assert.match(tanstack, /export const ContactSourceClientQueryOptions/);
    assert.match(tanstack, /export const UseContactSourceList/);
    assert.doesNotMatch(tanstack, /use\{\{/);
  });

  it("Kebab file names keep convertTypes client factories", async () => {
    const settings = { "languages.typescript.casing.file_names": "Kebab" };
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("contact-source"));
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/contact-source.ts",
    );
    assertClientNames(body, tanstack, settings, "contact_source");
    assert.match(body, /export const ContactSourceClient/);
  });

  it("Pascal file names keep convertTypes client factories", async () => {
    const settings = { "languages.typescript.casing.file_names": "Pascal" };
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("ContactSource"));
    assert.match(body, /export const ContactSourceClient/);
  });

  it("Snake file names keep convertTypes client factories", async () => {
    const settings = { "languages.typescript.casing.file_names": "Snake" };
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("contact_source"));
    assert.match(body, /export const ContactSourceClient/);
  });

  it("Pascal types keep client, options, and hooks on the same stem", async () => {
    const settings = { "languages.typescript.casing.types": "Pascal" };
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("contactSource"));
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/contactSource.ts",
    );
    assertClientNames(body, tanstack, settings, "contact_source");
    assert.match(body, /export const ContactSourceClient/);
    assert.match(tanstack, /export const UseContactSourceList/);
    assert.doesNotMatch(tanstack, /contactSourceClientQueryOptions/);
  });

  it("Snake types keep client, options, and hooks on the same stem", async () => {
    const settings = { "languages.typescript.casing.types": "Snake" };
    const entries = await generate(ctx(settings));
    const body = textOf(entries, fetchPath("contactSource"));
    const tanstack = textOf(
      entries,
      "frontend/src/client/tanstack/contactSource.ts",
    );
    assertClientNames(body, tanstack, settings, "contact_source");
    assert.match(body, /export const contact_source_client/);
    assert.match(tanstack, /export const contact_source_client_query_options/);
    assert.match(tanstack, /export const use_contact_source_list/);
    assert.doesNotMatch(tanstack, /useContactSourceList/);
    assert.doesNotMatch(tanstack, /usecontact_source_list/);
    assert.doesNotMatch(tanstack, /ContactSourceClientQueryOptions/);
  });
});
