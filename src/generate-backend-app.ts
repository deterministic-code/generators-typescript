import { fill } from "@deterministic-code/generators-common/fill";
import type { GenerateContext } from "@deterministic-code/generators-common/generate-context";
import { content, patch, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  appBootTestTs,
  appTs,
  dockerComposeYml,
  dockerfile,
  entrypointSh,
  envFile,
  gitignore,
  healthTestTs,
  packageJson,
  serverTs,
  tsconfigJson,
  vitestConfigTs,
} from "./resources/backend-app.ts";
import {
  minimalAppTs,
  minimalHealthTestTs,
  minimalPackageJson,
  minimalServerTs,
  minimalTsconfigJson,
} from "./resources/backend-app-minimal.ts";
import { Emit } from "./emit.ts";

const DEFAULT_APP_NAME = "generated-app";
const DEFAULT_COMPLEXITY = "deterministic";

type AppGenerateComplexity = "minimal" | "deterministic";

const complexityOf = (settings: Record<string, string>): AppGenerateComplexity => {
  const raw = settings.app_generate_complexity;
  if (raw === undefined || raw === "") return DEFAULT_COMPLEXITY;
  if (raw === "minimal" || raw === "deterministic") return raw;
  throw new Error(
    `settings.app_generate_complexity must be "minimal" or "deterministic", got ${JSON.stringify(raw)}`,
  );
};

class Generator extends Emit {
  from(appName: string, complexity: AppGenerateComplexity): GenerateEntry[] {
    return complexity === "minimal"
      ? this.minimal(appName)
      : this.deterministic(appName);
  }

  private tokens(appName: string) {
    const appFile = this.imports.app();
    const serverFile = this.imports.server();
    return {
      appName,
      appFnName: this.casing.appFnName(),
      appFile,
      appFileBase: this.casing.fileBase("app"),
      serverFile,
      serverFileBase: this.casing.fileBase("server"),
      healthTestFile: this.imports.appTest("health"),
      appBootTestFile: this.imports.appTest("app_boot"),
      statusField: this.casing.convertFields("status"),
      includeJson: JSON.stringify([
        appFile,
        serverFile,
        ...this.imports.tsconfigIncludes(),
        "perf-server.ts",
      ]),
    };
  }

  private minimal(appName: string): GenerateEntry[] {
    const named = this.tokens(appName);
    return [
      content(named.appFile, fill(minimalAppTs, named)),
      content(named.serverFile, fill(minimalServerTs, named)),
      content("package.json", fill(minimalPackageJson, named)),
      content("tsconfig.json", fill(minimalTsconfigJson, named)),
      content(named.healthTestFile, fill(minimalHealthTestTs, named)),
    ];
  }

  private deterministic(appName: string): GenerateEntry[] {
    const named = this.tokens(appName);
    const owned = new Set([
      named.serverFile,
      "tsconfig.json",
      named.healthTestFile,
    ]);
    return [
      ...this.minimal(appName).filter((e) => !owned.has(e.filename)),
      patch(named.appFile, fill(appTs, named)),
      content(named.serverFile, fill(serverTs, named)),
      patch("package.json", fill(packageJson, named)),
      content("tsconfig.json", fill(tsconfigJson, named)),
      patch("Dockerfile", fill(dockerfile, named)),
      patch(".dockerignore", "node_modules"),
      patch("scripts/entrypoint.sh", entrypointSh),
      patch("docker-compose.yml", dockerComposeYml),
      patch(".env", envFile),
      patch(".env.example", envFile),
      patch(".gitignore", gitignore),
      content("vitest.config.ts", vitestConfigTs),
      content(named.healthTestFile, fill(healthTestTs, named)),
      content(named.appBootTestFile, fill(appBootTestTs, named)),
    ];
  }
}

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const appName = ctx.settings.application_name || DEFAULT_APP_NAME;
  return new Generator(ctx.settings).from(
    appName,
    complexityOf(ctx.settings),
  );
};
