import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate as generateDatasourceTypeValidators } from "../src/generate-datasource-type-validators.ts";
import { generate as generateDatasourceTypes } from "../src/generate-datasource-types.ts";
import { generate as generateFrontendApp } from "../src/generate-frontend-app.ts";
import { generate as generateFrontendTypesTests } from "../src/generate-frontend-types-tests.ts";
import { generate as generateFrontendTypes } from "../src/generate-frontend-types.ts";
import { generate as generateFrontendValidatorsTests } from "../src/generate-frontend-validators-tests.ts";
import { generate as generateFrontendValidators } from "../src/generate-frontend-validators.ts";
import { removeE2eTempDirs } from "./cleanup-temp.ts";
import {
  freePort,
  installAndTestFrontend,
  npm,
  waitForUrl,
  type BootedApp,
} from "./generated-app.ts";
import {
  dumpCodegenEntries,
  dumpFinalFiles,
  verboseOutputEnabled,
} from "./verbose-output.ts";
import { writeGenerateEntries } from "./write-generate-entries.ts";

const nestUnder = (dir: string, entries: GenerateEntry[]): GenerateEntry[] =>
  entries
    .filter((entry) => entry.kind === "content")
    .map((entry) => ({ ...entry, filename: `${dir}/${entry.filename}` }));

export const generateFrontendSampleEntries = async (args: {
  yaml: Record<string, string>;
  settings: GenerateContext["settings"];
}): Promise<GenerateEntry[]> => {
  const ctx = { reader: memoryReader(args.yaml), settings: args.settings };
  const [
    types,
    typeTests,
    validators,
    validatorTests,
    datasourceTypes,
    datasourceValidators,
  ] = await Promise.all([
    generateFrontendTypes(ctx),
    generateFrontendTypesTests(ctx),
    generateFrontendValidators(ctx),
    generateFrontendValidatorsTests(ctx),
    generateDatasourceTypes(ctx),
    generateDatasourceTypeValidators(ctx),
  ]);
  return [
    ...types,
    ...typeTests,
    ...validators,
    ...validatorTests,
    ...nestUnder("types/generated/datasource", datasourceTypes),
    ...nestUnder("types/generated/datasource/validators", datasourceValidators),
  ];
};

export const bootGeneratedFrontend = async (args: {
  tempPrefix: string;
  settings: GenerateContext["settings"];
  yaml?: Record<string, string>;
}): Promise<BootedApp> => {
  await removeE2eTempDirs([args.tempPrefix]);
  const appDir = await mkdtemp(join(tmpdir(), args.tempPrefix));
  const appEntries = await generateFrontendApp({
    reader: memoryReader({}),
    settings: args.settings,
  });
  const sampleEntries =
    args.yaml === undefined
      ? []
      : await generateFrontendSampleEntries({
          yaml: args.yaml,
          settings: args.settings,
        });
  const entries = [...appEntries, ...sampleEntries];
  if (verboseOutputEnabled()) dumpCodegenEntries(entries);
  await writeGenerateEntries(appDir, entries);
  const frontendDir = join(appDir, "frontend");
  if (args.yaml !== undefined) {
    await writeFile(
      join(appDir, "package.json"),
      `${JSON.stringify(
        {
          name: "frontend-e2e-root",
          private: true,
          dependencies: {
            "@deterministic-code/deterministic": "^0.0.7",
            zod: "^3.23.8",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  if (verboseOutputEnabled()) await dumpFinalFiles(appDir);

  if (args.yaml !== undefined) {
    await Promise.all([
      installAndTestFrontend(appDir),
      npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], appDir),
    ]);
  } else {
    await npm(
      ["install", "--no-audit", "--no-fund", "--prefer-offline"],
      frontendDir,
    );
  }
  await npm(["run", "build"], frontendDir);

  const port = await freePort();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const framework = args.settings.frontend_generate_framework;
  const serveArgs =
    framework === "next"
      ? ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)]
      : framework === "angular"
        ? ["run", "preview", "--", "-l", `tcp://127.0.0.1:${port}`]
        : ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn("npm", serveArgs, {
    cwd: frontendDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  try {
    await waitForUrl(`http://127.0.0.1:${port}/`, 30_000);
  } catch (err) {
    const dumped = Buffer.concat([...stdoutChunks, ...stderrChunks]).toString();
    throw new Error(
      `frontend preview did not come up (exitCode=${child.exitCode})\n${dumped}\n${err}`,
    );
  }
  return { appDir, port, child, stdoutChunks, stderrChunks };
};
