import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { createCasing } from "../src/common/default-casing.ts";
import { generate } from "../src/generate-services.ts";

const TYPES = `types:
  - notification_type:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - channel_name:
            type: string
`;

const DATASOURCE = `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - notification_type:
      fields:
        - channel_name:
            is_unique: true
`;

const SERVICES_YAML = `includes:
  - types:
      filter: 'tag == "view_type"'
services: []
`;

const fixtureReader = () =>
  memoryReader({
    "types.yaml": TYPES,
    "datasource.yaml": DATASOURCE,
    "services.yaml": SERVICES_YAML,
  });

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

describe("generate services casing", () => {
  it("Auto uses Camel files, Pascal types, Snake fields", async () => {
    const files = await byFilename({});
    assert.ok(files.has("notificationTypeService.ts"));
    const body = files.get("notificationTypeService.ts")!;
    assert.match(
      body,
      /export class NotificationTypeService extends EntityService<NotificationType, number, Omit<NotificationType, "id">>/,
    );
    assert.match(body, /async find_by_channel_name\(channel_name: string\)/);
    assert.match(body, /export type INotificationTypeService =/);
    assert.doesNotMatch(body, /INotification_typeService/);
    assert.doesNotMatch(body, /InotificationTypeService/);
  });

  it("Pascal types wrap I plus every token: INotificationTypeService", async () => {
    const settings = { "languages.typescript.casing.types": "Pascal" };
    const files = await byFilename(settings);
    const body = files.get("notificationTypeService.ts")!;
    const index = files.get("index.ts")!;
    assert.match(body, /export type INotificationTypeService =/);
    assert.match(body, /export class NotificationTypeService /);
    assert.match(index, /export type \{ INotificationTypeService \} from/);
    assert.doesNotMatch(body, /INotification_typeService/);
    assert.doesNotMatch(body, /InotificationTypeService/);
  });

  it("Snake types wrap I plus every token: i_notification_type_service", async () => {
    const settings = { "languages.typescript.casing.types": "Snake" };
    const files = await byFilename(settings);
    const body = files.get("notificationTypeService.ts")!;
    const index = files.get("index.ts")!;
    assert.match(body, /export type i_notification_type_service =/);
    assert.match(body, /export class notification_type_service /);
    assert.match(index, /export type \{ i_notification_type_service \} from/);
    assert.doesNotMatch(body, /Inotification_type_service/);
    assert.doesNotMatch(body, /INotificationTypeService/);
  });

  it("Camel types wrap I plus every token: iNotificationTypeService", async () => {
    const settings = { "languages.typescript.casing.types": "Camel" };
    const files = await byFilename(settings);
    const body = files.get("notificationTypeService.ts")!;
    const index = files.get("index.ts")!;
    assert.match(body, /export type iNotificationTypeService =/);
    assert.match(body, /export class notificationTypeService /);
    assert.match(index, /export type \{ iNotificationTypeService \} from/);
    assert.doesNotMatch(body, /InotificationTypeService/);
    assert.doesNotMatch(body, /INotificationTypeService/);
  });

  it("Pascal file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Pascal",
    });
    assert.ok(files.has("NotificationTypeService.ts"));
  });

  it("Snake file names", async () => {
    const files = await byFilename({
      "languages.typescript.casing.file_names": "Snake",
    });
    assert.ok(files.has("notification_type_service.ts"));
  });

  it("Camel fields", async () => {
    const files = await byFilename({
      "languages.typescript.casing.fields": "Camel",
    });
    const body = files.get("notificationTypeService.ts")!;
    assert.match(body, /async findByChannelName\(channelName: string\)/);
  });

  it("Kebab directories with Pascal files under by-feature", async () => {
    const files = await byFilename({
      "other.organize_by_feature": "true",
      "languages.typescript.casing.file_names": "Pascal",
      "languages.typescript.casing.directories": "Kebab",
    });
    assert.ok(
      files.has("features/notification-type/NotificationTypeService.ts"),
    );
  });

  it("Pascal types convert custom service class and interface together", async () => {
    const settings = { "languages.typescript.casing.types": "Pascal" };
    const files = new Map<string, string>();
    for (const entry of await generate({
      reader: memoryReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ContactImportService
  - name: report_service
`,
      }),
      settings,
    })) {
      files.set(entry.filename, entryBody(entry));
    }
    const casing = createCasing(settings);
    const index = files.get("../custom/index.ts");
    assert.ok(index, `got ${[...files.keys()].join(", ")}`);
    for (const stem of ["ContactImportService", "report_service"]) {
      const interfaceName = casing.authoredInterfaceName(stem);
      const path = `../custom/${casing.fileBase(stem)}.ts`;
      const body = files.get(path);
      assert.ok(body, `missing ${path}; got ${[...files.keys()].join(", ")}`);
      assert.match(
        body,
        new RegExp(`export class ${stem} implements ${interfaceName}`),
      );
      assert.match(index, new RegExp(`export \\{ ${stem} \\} from`));
      assert.match(index, new RegExp(`export type \\{ ${interfaceName} \\} from`));
    }
    assert.equal(
      casing.convertTypes("ContactImportService"),
      "ContactImportService",
    );
    assert.equal(casing.convertTypes("report_service"), "ReportService");
  });

  it("Snake types keep the authored custom class name for runtime load", async () => {
    const settings = { "languages.typescript.casing.types": "Snake" };
    const files = new Map<string, string>();
    for (const entry of await generate({
      reader: memoryReader({
        "types.yaml": TYPES,
        "datasource.yaml": DATASOURCE,
        "services.yaml": `includes:
  - types:
      filter: 'tag == "view_type"'
services:
  - name: ContactImportService
  - name: report_service
`,
      }),
      settings,
    })) {
      files.set(entry.filename, entryBody(entry));
    }
    const casing = createCasing(settings);
    const index = files.get("../custom/index.ts");
    assert.ok(index, `got ${[...files.keys()].join(", ")}`);
    for (const stem of ["ContactImportService", "report_service"]) {
      const interfaceName = casing.authoredInterfaceName(stem);
      const path = `../custom/${casing.fileBase(stem)}.ts`;
      const body = files.get(path);
      assert.ok(body, `missing ${path}; got ${[...files.keys()].join(", ")}`);
      assert.match(
        body,
        new RegExp(`export class ${stem} implements ${interfaceName}`),
      );
      assert.match(index, new RegExp(`export \\{ ${stem} \\} from`));
      assert.match(index, new RegExp(`export type \\{ ${interfaceName} \\} from`));
    }
    assert.match(
      files.get(`../custom/${casing.fileBase("ContactImportService")}.ts`)!,
      /export class ContactImportService /,
    );
  });
});
