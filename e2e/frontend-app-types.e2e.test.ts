import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stopGeneratedApp, type BootedApp } from "./generated-app.ts";
import { bootGeneratedFrontend } from "./generated-frontend-app.ts";
import {
  PARENT_CHILD_EAGER_YAML,
  PARENT_CHILD_SETTINGS,
} from "./parent-child-eager-yaml.ts";

const TEMP_PREFIX = "ts-frontend-app-types-e2e-";
const APPLICATION_NAME = "frontend-e2e";

const requireFile = async (path: string): Promise<void> => {
  await access(path);
};

describe("frontend-app types e2e", { timeout: 180_000 }, () => {
  let booted: BootedApp | undefined;

  before(async () => {
    booted = await bootGeneratedFrontend({
      tempPrefix: TEMP_PREFIX,
      settings: {
        ...PARENT_CHILD_SETTINGS,
        application_name: APPLICATION_NAME,
      },
      yaml: PARENT_CHILD_EAGER_YAML,
    });
  });

  after(async () => {
    await stopGeneratedApp(booted, TEMP_PREFIX);
  });

  it("writes frontend types, validators, and tests from the backend sample", async () => {
    assert.ok(booted);
    const { appDir } = booted;
    await Promise.all(
      [
        "frontend/src/types/project.ts",
        "frontend/src/types/project.test.ts",
        "frontend/src/types/task.ts",
        "frontend/src/types/task.test.ts",
        "frontend/src/types/status.ts",
        "frontend/src/validators/project.ts",
        "frontend/src/validators/project.test.ts",
        "frontend/src/validators/task.ts",
        "frontend/src/validators/task.test.ts",
        "types/datasource/project.ts",
        "types/datasource/validators/project.ts",
      ].map((rel) => requireFile(join(appDir, rel))),
    );
  });

  it("serves the generated Vite preview with the app name", async () => {
    assert.ok(booted);
    const origin = `http://127.0.0.1:${booted.port}`;
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`<title>${APPLICATION_NAME}</title>`));
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/);
    assert.ok(asset?.[1], "preview HTML is missing the Vite JS asset");
    const js = await fetch(`${origin}${asset[1]}`);
    assert.equal(js.status, 200);
    assert.match(await js.text(), new RegExp(APPLICATION_NAME));
  });
});
