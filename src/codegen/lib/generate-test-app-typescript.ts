import { buildTestAppSpec } from "../../sdk/codegen/lib/integration-test-spec.ts";
import type { TestAppArgs } from "../../sdk/codegen/lib/integration-test-spec.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import {
  datasourceSettingsFor,
  settingsConfigLiteral,
} from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import { SECTION_MARKERS } from "../../sdk/section-markers.ts";
import type { GeneratedFile } from "../../sdk/codegen/lib/routes-generate-types.ts";

interface StubMethod {
  serviceMethod: string;
  sampleResponse: unknown;
}

interface CustomService {
  serviceName: string;
  stubClassName: string;
  methods: StubMethod[];
}

interface GenerateTestAppOptions {
  datasourceData: unknown;
  routesData: unknown;
  viewTypesData: unknown;
  factoryName?: string;
  pluralizeTableNames?: boolean;
  datetime?: string;
  uuid?: string;
  idType?: string;
  libraryReferenceMode?: string;
  organizeByFeature?: boolean;
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function assertObjectDoc(name: string, data: unknown): void {
  if (!data || typeof data !== "object") {
    throw new Error(`generateTestApp: ${name} is required`);
  }
}

/** One stub class per service; each async method returns the spec-build-time sample so the stub's reply is byte-equivalent to what the OpenAPI conformance validator expects. */
function renderStubClass(service: CustomService): string {
  const methodLines = service.methods.map((m) => {
    const returnLiteral =
      m.sampleResponse === null ? "null" : JSON.stringify(m.sampleResponse);
    return `  async ${m.serviceMethod}(): Promise<unknown> {\n    return ${returnLiteral};\n  }`;
  });
  return [
    `class ${service.stubClassName} {`,
    `  static readonly dependencies = [] as const;`,
    ...methodLines,
    `}`,
  ].join("\n");
}

function renderServiceSpecsLiteral(serviceNames: string[]): string {
  if (serviceNames.length === 0) return "[]";
  const entries = serviceNames.map(
    (name) => `    { name: "${name}", args: [] }`,
  );
  return `[\n${entries.join(",\n")},\n  ]`;
}

function renderClassRegistryEntries(customServices: CustomService[]): string {
  const stubLines = customServices.map(
    (svc) =>
      `      ${svc.serviceName}: ${svc.stubClassName} as unknown as new (...a: unknown[]) => unknown,`,
  );
  return stubLines.join("\n");
}

export function generateTestApp({
  datasourceData,
  routesData,
  viewTypesData,
  factoryName = "createTestApp",
  pluralizeTableNames = true,
  datetime = "native",
  uuid = "native",
  idType = "integer",
  libraryReferenceMode,
  organizeByFeature = false,
}: GenerateTestAppOptions): GeneratedFile {
  assertObjectDoc("datasourceData", datasourceData);
  assertObjectDoc("routesData", routesData);
  assertObjectDoc("viewTypesData", viewTypesData);

  const spec = buildTestAppSpec({
    datasourceData,
    routesData,
    viewTypesData,
  } as TestAppArgs) as { customServices: CustomService[] };

  const datasourceJson = jsonLiteral(datasourceData);
  const routesJson = jsonLiteral(routesData);
  const viewTypesJson = jsonLiteral(viewTypesData);

  const { customServices } = spec;
  const serviceNames = customServices.map((svc) => svc.serviceName);

  const stubClasses = customServices.map(renderStubClass).join("\n\n");

  const classRegistryStubEntries = renderClassRegistryEntries(customServices);
  const serviceSpecsLiteral = renderServiceSpecsLiteral(serviceNames);
  const routeSpecsExpr =
    serviceNames.length > 0 ? "parseGenericRouteSpecs(routesData)" : "[]";
  const parseGenericImport =
    serviceNames.length > 0 ? "\n  parseGenericRouteSpecs," : "";

  const detRootImport = libraryImportSpecifier(
    "",
    libraryReferenceMode,
    "__tests__/test-app.ts",
  );
  const middlewareImport = libraryImportSpecifier(
    "middleware",
    libraryReferenceMode,
    "__tests__/test-app.ts",
  );
  // The generated app-wiring lives in the same crate; test-app.ts sits under __tests__/, so reach it relatively (flat: routes/generated/, by-feature: features/).
  const composeRouterImport = organizeByFeature
    ? "../features/app-wiring.js"
    : "../routes/generated/app-wiring.js";
  const content = `import { type NextFunction, type Request, type Response, type Express } from "express";
import {
  createBackendApp,
  parseCrudRouteSpecs,
  parseEnableMiddlewareEnv,${parseGenericImport}
  type DatabaseConnection,
} from "${detRootImport}";
import { traceRouteMiddleware, jsonBodyMiddleware } from "${middlewareImport}";
import { composeRouter } from "${composeRouterImport}";

const datasourceData = ${datasourceJson} as const;

const routesData = ${routesJson} as const;

const viewTypesData = ${viewTypesJson} as const;

class TerminalHandler {
  static readonly dependencies = [] as const;
  handle = (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(404).json({ errors: [{ code: "NOT_FOUND", message: "Route not found" }] });
  };
}${stubClasses ? "\n\n" + stubClasses : ""}

const jsonParser = jsonBodyMiddleware;
// noopLookup carve-out for traceRoute: route-tier [route] Start/Finish/Error lines only mount when DETERMINISTIC_TRACE=route maps the name to the real middleware; otherwise jsonParser would mask it and only [service]/[datasource] lines would appear. jsonBodyMiddleware (guarded) turns a malformed body into a 400, not a 500.
const noopLookup = {
  get: (name: string) =>
    name === "traceRoute" ? traceRouteMiddleware : jsonParser,
} as unknown as ConstructorParameters<typeof Object>[0];

${SECTION_MARKERS.TESTAPP_DB_CONN.start}
async function resolveTestConnection(): Promise<DatabaseConnection> {
  return { type: "memory", close: () => Promise.resolve() } as unknown as DatabaseConnection;
}
${SECTION_MARKERS.TESTAPP_DB_CONN.end}

export async function ${factoryName}(): Promise<Express> {
  const conn = await resolveTestConnection();
  const crudSpecs = parseCrudRouteSpecs(datasourceData, routesData, { projectIdType: "${idType}", viewTypesDoc: viewTypesData });
  const app = await createBackendApp(conn, {
    enableMiddleware: parseEnableMiddlewareEnv(process.env.DETERMINISTIC_TRACE),
    backendAppConfig: {
      middleware: [{ name: "bodyParser", type: "app", enabled: true }],
      // ErrorHandlerMiddlewareService must come before TerminalHandler so next(err) surfaces as JSON \\{errors:[\\{code,message\\}]\\} (else Express's default HTML handler masks every server error). Each entry must be the normalized HandlerEntry shape (\\{name, enabled: true\\}) — see CLAUDE.md GATE 12.
      handlers: [
        { name: "ErrorHandlerMiddlewareService", enabled: true },
        { name: "TerminalHandler", enabled: true },
      ],
    },
    settingsConfig: ${settingsConfigLiteral(datasourceSettingsFor({ pluralizeTableNames, datetime, uuid, idType }))},
    routeSpecs: ${routeSpecsExpr},
    routeComposer: composeRouter,
    crudSpecs,
    datasourceData: datasourceData as unknown as never,
    routesData: routesData as unknown as never,
    viewTypesDoc: viewTypesData as unknown as never,
    serviceSpecs: ${serviceSpecsLiteral},
    classRegistry: {
      TerminalHandler: TerminalHandler as unknown as new (...a: unknown[]) => unknown,${classRegistryStubEntries ? "\n" + classRegistryStubEntries : ""}
    },
    middlewareLookup: noopLookup as never,
    // No app-level seed loop — generated _initial_up.sql already INSERTs every \`seeds:\` row, so re-seeding here would UNIQUE-violate (GATE 11). For test-only fixtures outside the production schema, generate an \`onAfterCreateApp\` hook instead.
  });

  (app as unknown as { __cleanup: () => Promise<void> }).__cleanup = async () => {
    await conn.close();
  };

  return app;
}
`;

  return { path: "test-app.ts", content };
}
