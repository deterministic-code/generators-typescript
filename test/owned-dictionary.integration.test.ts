import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { DeterministicParser } from "@deterministic-code/deterministic-specifications-typescript/parser";
import { generate as generateDatasourceTypes } from "../src/generate-datasource-types.ts";
import { generate as generateViewTypes } from "../src/generate-view-types.ts";
import { generate as generateViewTypeValidators } from "../src/generate-view-type-validators.ts";

const KITCHEN_SINK = `types:
  - file:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
            size: 64
        - description:
            type: string
            size: unlimited
            is_nullable: true
        - size:
            type: integer
        - settings:
            type: settings{}
            references: settings.key
  - settings:
      tags: [datasource_type]
      inherits: dictionary
      fields:
        - setting_id:
            type: integer
            references: file.id
        - key:
            type: string
            size: 64
        - value:
            type: string
            size: unlimited
  - role:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
            size: 64
        - code:
            type: string
            size: 64
  - contact_source:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
            size: 64
  - contact_type:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
            size: 64
        - description:
            type: string
            size: unlimited
            is_nullable: true
  - card_labels:
      tags: [view_type]
      inherits: dictionary
      fields:
        - key:
            type: string
            size: 64
        - value:
            type: string
            size: 128
  - contact_card:
      tags: [view_type]
      fields:
        - display_name:
            type: string
            size: 256
        - labels:
            type: card_labels{}
            references: card_labels.key
  - locale_pref:
      tags: [view_type]
      fields:
        - locale:
            type: string
            size: 16
        - timezone:
            type: string
            size: 64
  - contact_prefs:
      tags: [datasource_type]
      inherits: dictionary
      fields:
        - contact_id:
            type: integer
            references: contacts_ds.id
        - key:
            type: string
            size: 64
        - value:
            type: locale_pref
  - contacts_ds:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
  - contact:
      tags: [view_type]
      inherits: contacts_ds
      fields:
        - prefs:
            type: contact_prefs{}
            references: contact_prefs.key
  - contacts_base:
      tags: [view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
  - typed_contact:
      tags: [view_type]
      inherits: contacts_base
      union: [contact_source, contact_type]
      extract: [contact_source.name, contact_type.name]
      mapping:
        contact_source.name: contact_source_name
        contact_type.name: contact_type_name
`;

const ctx = {
  reader: memoryReader({ [TYPES_YAML]: KITCHEN_SINK }),
  settings: {},
};

const entryBody = (entry: GenerateEntry): string => {
  if ("contents" in entry) return String(entry.contents);
  return entry.content;
};

const indexEntries = (entries: GenerateEntry[]): Map<string, GenerateEntry> => {
  const map = new Map<string, GenerateEntry>();
  for (const entry of entries) {
    assert.equal(
      map.has(entry.filename),
      false,
      `duplicate generate entry: ${entry.filename}`,
    );
    map.set(entry.filename, entry);
  }
  return map;
};

const requireEntry = (
  map: Map<string, GenerateEntry>,
  filename: string,
): GenerateEntry => {
  const entry = map.get(filename);
  if (entry === undefined) {
    throw new Error(`missing generate entry: ${filename}`);
  }
  return entry;
};

describe("owned dictionary codegen", () => {
  it("expands settings as authored fields and typed_contact via extract+mapping", async () => {
    const spec = await DeterministicParser(ctx.reader).parse(ctx.settings);
    const names = (name: string) =>
      spec.expandedTypes.find((t) => t.name === name)?.fields.map((f) => f.name);
    assert.deepEqual(names("settings"), ["setting_id", "key", "value"]);
    assert.deepEqual(names("file"), [
      "id",
      "name",
      "description",
      "size",
      "settings",
    ]);
    assert.deepEqual(names("typed_contact"), [
      "id",
      "email",
      "contact_source_name",
      "contact_type_name",
    ]);
    assert.equal(
      spec.types.some(
        (t) => t.name === "settings" && t.tags.includes("view_type"),
      ),
      false,
    );
  });

  it("emits Settings as a row-shaped datasource type", async () => {
    const entries = indexEntries(await generateDatasourceTypes(ctx));
    const settings = entryBody(requireEntry(entries, "settings.ts"));
    assert.match(settings, /export interface Settings \{/);
    assert.match(settings, /setting_id: number;/);
    assert.match(settings, /key: string;/);
    assert.match(settings, /value: string;/);
    assert.doesNotMatch(settings, /\bid:/);
    assert.doesNotMatch(settings, /Dictionary/);
    const file = entryBody(requireEntry(entries, "file.ts"));
    assert.doesNotMatch(file, /settings/);
    assert.doesNotMatch(file, /Dictionary/);
  });

  it("attaches Dictionary on the File view only and does not emit a Settings view", async () => {
    const entries = indexEntries(await generateViewTypes(ctx));
    assert.equal(entries.has("settings.ts"), false);
    const file = entryBody(requireEntry(entries, "file.ts"));
    assert.match(file, /type Dictionary<K extends PropertyKey, V> = Record<K, V>;/);
    assert.match(file, /export interface File extends FileBase \{/);
    assert.match(file, /settings: Dictionary<string, string>;/);
    assert.doesNotMatch(file, /\bkey:/);
    assert.doesNotMatch(file, /\bvalue:/);
    assert.doesNotMatch(file, /setting_id/);
    const typed = entryBody(requireEntry(entries, "typedContact.ts"));
    assert.match(typed, /export interface TypedContact \{/);
    assert.match(typed, /id: number;/);
    assert.match(typed, /email: string;/);
    assert.match(typed, /contact_source_name: string;/);
    assert.match(typed, /contact_type_name: string;/);
    assert.doesNotMatch(typed, /Dictionary/);
    const role = entryBody(requireEntry(entries, "role.ts"));
    assert.doesNotMatch(role, /Dictionary/);
    assert.equal(entries.has("cardLabels.ts"), false);
    const card = entryBody(requireEntry(entries, "contactCard.ts"));
    assert.match(card, /labels: Dictionary<string, string>;/);
    assert.equal(entries.has("contactPrefs.ts"), false);
    const contactView = entryBody(requireEntry(entries, "contact.ts"));
    assert.match(contactView, /prefs: Dictionary<string, LocalePref>;/);
    const locale = entryBody(requireEntry(entries, "localePref.ts"));
    assert.match(locale, /export interface LocalePref \{/);
  });

  it("validates File view settings as z.record, not a Settings schema", async () => {
    const entries = indexEntries(await generateViewTypeValidators(ctx));
    assert.equal(entries.has("settings.ts"), false);
    const file = entryBody(requireEntry(entries, "file.ts"));
    assert.match(file, /settings: z\.record\(z\.string\(\), z\.string\(\)\)/);
    assert.doesNotMatch(file, /SettingsSchema/);
    const contact = entryBody(requireEntry(entries, "contact.ts"));
    assert.match(contact, /prefs: z\.record\(z\.string\(\), z\.lazy\(\(\) => LocalePrefSchema\)\)/);
    const prefsRow = indexEntries(await generateDatasourceTypes(ctx));
    const row = entryBody(requireEntry(prefsRow, "contactPrefs.ts"));
    assert.match(row, /locale: string;/);
    assert.match(row, /timezone: string;/);
    assert.doesNotMatch(row, /\bvalue:/);
  });
});
