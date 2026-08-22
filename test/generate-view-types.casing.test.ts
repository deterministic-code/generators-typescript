import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import { VIEW_TYPES_YAML } from "@deterministic-code/deterministic-specifications-typescript/parser";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "../src/generate-view-types.ts";

const FIXTURE_YAML = `types:
  - notification_type:
      fields:
        - channel_name:
            type: string
`;

const fixtureReader = () =>
  memoryReader({ [VIEW_TYPES_YAML]: FIXTURE_YAML });

const entryBody = (entry: GenerateEntry): string => {
  if ("contents" in entry) return String(entry.contents);
  return entry.content;
};

const byFilename = async (settings: Record<string, string>) => {
  const map = new Map<string, string>();
  for (const entry of await generate({
    reader: fixtureReader(),
    settings,
  })) {
    map.set(entry.filename, entryBody(entry));
  }
  return map;
};

describe("generate view types casing", () => {
  it("Auto uses Camel files, Pascal types, Snake fields", async () => {
    const files = await byFilename({});
    assert.ok(files.has("notificationType.ts"));
    const body = files.get("notificationType.ts")!;
    assert.match(body, /export interface NotificationType /);
    assert.match(body, /channel_name: string;/);
  });

  it("Pascal file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.ok(files.has("NotificationType.ts"));
  });

  it("Snake file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Snake",
    });
    assert.ok(files.has("notification_type.ts"));
  });

  it("Camel fields", async () => {
    const files = await byFilename({
      "languages.typescript.casing.fields": "Camel",
    });
    assert.match(files.get("notificationType.ts")!, /channelName: string;/);
  });

  it("Kebab directories with Pascal files under by-feature", async () => {
    const files = await byFilename({
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.ok(files.has("features/notification-type/NotificationType.ts"));
  });
});
