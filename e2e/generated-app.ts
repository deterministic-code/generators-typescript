import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  memoryReader,
  type IDeterministicReader,
} from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate as generateMigrate } from "../../generators-migraters/typescript/generate.ts";
import { generate } from "../src/generate-backend-app.ts";
import { removeE2eTempDirs } from "./cleanup-temp.ts";
import {
  dumpCodegenEntries,
  dumpFinalFiles,
  verboseOutputEnabled,
} from "./verbose-output.ts";
import { writeGenerateEntries } from "./write-generate-entries.ts";

const execFileAsync = promisify(execFile);

export const SQLITE_DB_FILE = "dev.sqlite";

/** e2e vendors the runtime until the published npm pin is current. */
export const BUNDLED_LIBRARY_MODE = {
  "languages.typescript.library_reference_mode": "bundled",
} as const;

export const withBundledLibrary = (
  settings: GenerateContext["settings"],
): GenerateContext["settings"] => ({
  ...settings,
  ...BUNDLED_LIBRARY_MODE,
});

export const MINIMAL_DETERMINISTIC_YAML: Record<string, string> = {
  "settings.yaml": `settings:
  datasource:
    pluralize_datatable_names: true
  languages:
    typescript:
      library_reference_mode: bundled
`,
  "backend-app.yaml": `middleware: []
handlers: []
`,
  "services.yaml": "services: []\n",
  "routes.yaml": "routes: []\n",
  "types.yaml": "version: 1.0.0\ntypes: []\n",
  "datasource.yaml": "version: 1.0.0\ntypes: []\n",
};

type ExecErr = Error & { stdout?: string; stderr?: string; code?: unknown };

const failOnNpmNoise = (stderr: string, args: string[]): void => {
  const fatal = stderr
    .split(/\r?\n/)
    .filter((line) => /^(npm warn |npm error )/i.test(line.trim()));
  if (fatal.length > 0) {
    throw new Error(
      `npm ${args.join(" ")} wrote warnings/errors (treated as failures):\n${fatal.join("\n")}`,
    );
  }
};

export const npm = async (
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  const env = { ...process.env, ...extraEnv };
  // Cursor sandbox sets this node-gyp path; npm 11 warns it is not a config.
  delete env.npm_config_devdir;
  try {
    const { stderr } = await execFileAsync("npm", args, {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    failOnNpmNoise(stderr, args);
  } catch (err) {
    const exec = err as ExecErr;
    if (typeof exec.stderr === "string") {
      failOnNpmNoise(exec.stderr, args);
      throw new Error(
        `npm ${args.join(" ")} failed (exit ${String(exec.code ?? "?")}):\n${exec.stderr}\n${exec.stdout ?? ""}`,
      );
    }
    throw err;
  }
};

export const installFrontend = async (appDir: string): Promise<void> => {
  await npm(
    ["install", "--no-audit", "--no-fund", "--prefer-offline"],
    join(appDir, "frontend"),
  );
};

export const testFrontend = async (
  appDir: string,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  await npm(["test"], join(appDir, "frontend"), extraEnv);
};

export const testBackend = async (
  appDir: string,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  await npm(["test"], appDir, extraEnv);
};

export const installAndTestFrontend = async (
  appDir: string,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  await installFrontend(appDir);
  await testFrontend(appDir, extraEnv);
};

export const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
};

export const waitForUrl = async (
  url: string,
  timeoutMs: number,
): Promise<Response> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`${url} -> ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`timed out waiting for ${url}`);
};

export const writeDeterministicYaml = async (
  appDir: string,
  files: Record<string, string> = MINIMAL_DETERMINISTIC_YAML,
): Promise<void> => {
  const dir = join(appDir, "deterministic");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, body]) =>
      writeFile(join(dir, name), body, "utf8"),
    ),
  );
};

/** SQL generator emits `<dialect>/migrations/…`; migrate scripts look under `sql/`. */
export const withSqlRoot = (entries: GenerateEntry[]): GenerateEntry[] =>
  entries.map((entry) =>
    entry.kind === "content" && !entry.filename.startsWith("sql/")
      ? { ...entry, filename: `sql/${entry.filename}` }
      : entry,
  );

export const generateBundledMigrate = (
  settings: GenerateContext["settings"],
  reader: IDeterministicReader = memoryReader({}),
): Promise<GenerateEntry[]> =>
  generateMigrate({
    reader,
    settings: {
      ...settings,
      "languages.typescript.migrate_mode": "bundled",
    },
  });

export const sqliteAppEnv = (appDir: string): Record<string, string> => ({
  DATABASE_BACKEND: "sqlite",
  DB_PATH: join(appDir, SQLITE_DB_FILE),
});

export const installBuildAndMigrateSqlite = async (
  appDir: string,
): Promise<string> => {
  const dbPath = join(appDir, SQLITE_DB_FILE);
  await npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], appDir);
  await npm(["run", "migrate:build"], appDir);
  const env = sqliteAppEnv(appDir);
  await npm(["run", "migrate:setup"], appDir, env);
  await npm(["run", "migrate"], appDir, env);
  const failures: string[] = [];
  for (const [label, run] of [
    ["test", () => testBackend(appDir)],
    ["build", () => npm(["run", "build"], appDir)],
  ] as const) {
    try {
      await run();
    } catch (err) {
      failures.push(
        `npm ${label} failed:\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
  return dbPath;
};

export type BootedApp = {
  appDir: string;
  port: number;
  child: ChildProcess;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
};

export const startGeneratedServer = async (
  appDir: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedApp> => {
  const port = await freePort();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: appDir,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/health`, 30_000);
  } catch (err) {
    const dumped = Buffer.concat(stderrChunks).toString();
    throw new Error(
      `health check did not come up (exitCode=${child.exitCode})\n${dumped}\n${err}`,
    );
  }
  return { appDir, port, child, stdoutChunks, stderrChunks };
};

export const bootGeneratedApp = async (args: {
  tempPrefix: string;
  settings: GenerateContext["settings"];
  writeYaml: boolean;
}): Promise<BootedApp> => {
  await removeE2eTempDirs([args.tempPrefix]);
  const appDir = await mkdtemp(join(tmpdir(), args.tempPrefix));
  const entries = await generate({
    reader: memoryReader({}),
    settings: withBundledLibrary(args.settings),
  });
  if (verboseOutputEnabled()) dumpCodegenEntries(entries);
  await writeGenerateEntries(appDir, entries);
  if (args.writeYaml) await writeDeterministicYaml(appDir);
  if (verboseOutputEnabled()) await dumpFinalFiles(appDir);
  await npm(["install", "--no-audit", "--no-fund", "--prefer-offline"], appDir);
  await npm(["run", "build"], appDir);
  return startGeneratedServer(appDir);
};

export const stopGeneratedApp = async (booted: BootedApp | undefined, tempPrefix: string): Promise<void> => {
  if (booted === undefined) {
    await removeE2eTempDirs([tempPrefix]);
    return;
  }
  if (booted.child.exitCode === null && booted.child.signalCode === null) {
    booted.child.kill("SIGTERM");
    await once(booted.child, "exit").catch(() => undefined);
  }
  await rm(booted.appDir, { recursive: true, force: true });
  await removeE2eTempDirs([tempPrefix]);
};
