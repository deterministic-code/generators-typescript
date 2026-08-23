import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { TYPES_YAML } from "@deterministic-code/generators-common/spec-types";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-datasource-types.ts";

const FIXTURE_YAML = `types:
  - notification_type:
      tags: [datasource_type]
      fields:
        - channel_name:
            type: string
`;

const fixtureReader = () =>
  memoryReader({ [TYPES_YAML]: FIXTURE_YAML });

const entryBody = (entry: GenerateEntry): string => {
  if ("contents" in entry) return String(entry.contents);
  return entry.content;
};

const generateWith = (settings: Record<string, string>) =>
  generate({ reader: fixtureReader(), settings });

const byFilename = async (settings: Record<string, string>) => {
  const map = new Map<string, string>();
  for (const entry of await generateWith(settings)) {
    map.set(entry.filename, entryBody(entry));
  }
  return map;
};

describe("generate datasource types casing", () => {
  it("Auto uses Camel files, Pascal types, Snake fields", async () => {
    const files = await byFilename({});
    assert.deepEqual(
      [...files.keys()].sort(),
      ["index.ts", "notificationType.ts"],
    );
    const body = files.get("notificationType.ts")!;
    assert.match(body, /export interface NotificationType /);
    assert.match(body, /channel_name: string;/);
  });

  it("Pascal file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.ok(files.has("NotificationType.ts"));
    assert.match(
      files.get("NotificationType.ts")!,
      /export interface NotificationType /,
    );
  });

  it("Snake file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Snake",
    });
    assert.ok(files.has("notification_type.ts"));
  });

  it("Kebab file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Kebab",
    });
    assert.ok(files.has("notification-type.ts"));
  });

  it("Snake type names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.types": "Snake",
    });
    assert.match(
      files.get("notificationType.ts")!,
      /export interface notification_type /,
    );
  });

  it("Camel type names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.types": "Camel",
    });
    assert.match(
      files.get("notificationType.ts")!,
      /export interface notificationType /,
    );
  });

  it("Camel fields", async () => {
    const files = await byFilename({
      "languages.typescript.casing.fields": "Camel",
    });
    assert.match(files.get("notificationType.ts")!, /channelName: string;/);
  });

  it("Pascal fields", async () => {
    const files = await byFilename({
      "languages.typescript.casing.fields": "Pascal",
    });
    assert.match(files.get("notificationType.ts")!, /ChannelName: string;/);
  });

  it("Kebab directories with Pascal files under by-feature", async () => {
    const files = await byFilename({
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.ok(
      files.has("features/notification-type/NotificationType.datasource.ts"),
    );
  });

  it("Camel directories with Snake files under by-feature", async () => {
    const files = await byFilename({
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Snake",
      "languages.typescript.casing.directories": "Camel",
    });
    assert.ok(
      files.has("features/notificationType/notification_type.datasource.ts"),
    );
  });
});
