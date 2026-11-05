import { snakeToPascal } from "../../sdk/case.ts";
import {
  nestedRouterFileBase,
  nestedRouterFnName,
  nestedRouteEntity,
  descriptorFileFormat,
  nestedMountPath,
} from "./generate-nested-routes-typescript.ts";
import {
  layoutFor,
  namesFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import {
  datasourceSettingsFor,
  type DatasourceOptions,
} from "../../sdk/codegen/lib/ts-datasource-settings.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import { sampleIdFactory } from "./route-test-sample-id.ts";
import type { GeneratedFile } from "../../sdk/codegen/lib/routes-generate-types.ts";
import type {
  NestedRouteDescriptor,
  DirectFkDescriptor,
  M2mDescriptor,
} from "./nested-routes-generate-types.ts";

interface NestedRouteTestOptions extends NamesForOptions, DatasourceOptions {
  libraryReferenceMode?: string;
}

interface PrimaryKeyMock {
  importLine: string;
  expr: string;
}

function nestedIdFactory(options: NestedRouteTestOptions) {
  return sampleIdFactory(datasourceSettingsFor(options).idType);
}

/** The `import { PrimaryKey }` line + `new PrimaryKey("id", <idType>)` expression the nested-router tests use for their mock services, so the router parses `/:parentId` / `/:childId` from the injected services' `.primaryKey` as production does. */
function primaryKeyMock(
  options: NestedRouteTestOptions,
  testPath: string,
): PrimaryKeyMock {
  const idType = datasourceSettingsFor(options).idType;
  const repositoriesImport = libraryImportSpecifier(
    "repositories",
    options.libraryReferenceMode,
    testPath,
  );
  return {
    importLine: `import { PrimaryKey } from "${repositoriesImport}";`,
    expr: `new PrimaryKey("id", ${JSON.stringify(idType)})`,
  };
}

const MOCK_FACTORY = `function createMock(primaryKey?: any): any {
  return {
    primaryKey,
    query: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findBy: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (data: unknown) => ({ id: 1, ...(data as object) })),
    update: vi.fn(async (id: number, data: unknown) => ({ id, ...(data as object) })),
    patch: vi.fn(async (id: number, data: unknown) => ({ id, ...(data as object) })),
    delete: vi.fn().mockResolvedValue(true),
    updateBy: vi.fn().mockResolvedValue(0),
    deleteBy: vi.fn().mockResolvedValue(0),
  };
}
`;

function nestedM2mTestContent(
  descriptor: M2mDescriptor,
  options: NestedRouteTestOptions,
): string {
  const fileFormat = descriptorFileFormat(options);
  const fnName = nestedRouterFnName(descriptor);
  const fileBase = nestedRouterFileBase(descriptor, fileFormat);
  const parentPascal = snakeToPascal(descriptor.parent); // lint-generator-casing-allow: snakeToPascal
  const targetPascal = snakeToPascal(descriptor.target); // lint-generator-casing-allow: snakeToPascal
  const mountPath = nestedMountPath(descriptor);
  const id = nestedIdFactory(options);
  const parent = id(1);
  const child = id(2);
  const collectionUrl = `${mountPath}/${parent.url}/${descriptor.segmentTail}`;
  const memberUrl = `${mountPath}/${parent.url}/${descriptor.segmentTail}/${child.url}`;
  const junctionRow = `{ id: 9, ${descriptor.parentFkField}: ${parent.lit}, ${descriptor.childFkField}: ${child.lit} }`;
  const pk = primaryKeyMock(options, nestedRouterTestPath(descriptor, options));
  return `import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Application } from "express";
import request from "supertest";
${pk.importLine}
import { ${fnName} } from "../${fileBase}";

${MOCK_FACTORY}
describe("${fnName}", () => {
  let parentService: any;
  let junctionService: any;
  let targetService: any;
  let app: Application;

  beforeEach(() => {
    parentService = createMock(${pk.expr});
    parentService.findById.mockResolvedValue({ id: ${parent.lit}, name: "${descriptor.parent}-1" });
    junctionService = createMock(${pk.expr});
    targetService = createMock(${pk.expr});
    targetService.findAll.mockResolvedValue([{ id: ${child.lit}, name: "${descriptor.target}-2" }]);
    targetService.findById.mockResolvedValue({ id: ${child.lit}, name: "${descriptor.target}-2" });
    app = express();
    app.use(express.json());
    app.use("${mountPath}", ${fnName}(parentService, junctionService, targetService));
  });

  it("GET ${collectionUrl} returns linked ${targetPascal} rows for the ${parentPascal}", async () => {
    junctionService.findAll.mockResolvedValueOnce([
      ${junctionRow},
    ]);
    const res = await request(app).get("${collectionUrl}");
    expect(res.status).toBe(200);
    expect(parentService.findById).toHaveBeenCalledWith(${parent.lit});
    expect(junctionService.findAll).toHaveBeenCalled();
  });

  it("GET ${collectionUrl} returns 404 when ${parentPascal} parent does not exist", async () => {
    parentService.findById.mockResolvedValueOnce(null);
    const res = await request(app).get("${collectionUrl}");
    expect(res.status).toBe(404);
  });

  it("GET ${memberUrl} resolves the linked ${targetPascal} when the junction exists", async () => {
    junctionService.findAll.mockResolvedValueOnce([
      ${junctionRow},
    ]);
    const res = await request(app).get("${memberUrl}");
    expect(res.status).toBe(200);
    expect(targetService.findById).toHaveBeenCalledWith(${child.lit});
  });

  it("GET ${memberUrl} returns 404 when no junction links the ${targetPascal} to the ${parentPascal}", async () => {
    junctionService.findAll.mockResolvedValueOnce([]);
    const res = await request(app).get("${memberUrl}");
    expect(res.status).toBe(404);
  });

  it("DELETE ${memberUrl} removes the junction record", async () => {
    junctionService.findAll.mockResolvedValueOnce([
      ${junctionRow},
    ]);
    const res = await request(app).delete("${memberUrl}");
    expect(res.status).toBe(200);
    expect(junctionService.delete).toHaveBeenCalledWith(9);
  });
});
`;
}

function nestedDirectFkTestContent(
  descriptor: DirectFkDescriptor,
  options: NestedRouteTestOptions,
): string {
  const fileFormat = descriptorFileFormat(options);
  const fnName = nestedRouterFnName(descriptor);
  const fileBase = nestedRouterFileBase(descriptor, fileFormat);
  const childName = descriptor.child.name;
  const childPascal = snakeToPascal(childName); // lint-generator-casing-allow: snakeToPascal
  const validatorFileBase = namesFor(options).fileBase(
    childName,
    "view-validator",
  );
  const validatorPath = layoutFor(options).testImportSpecifier(
    { entity: nestedRouteEntity(descriptor), artifact: "route" },
    { entity: childName, artifact: "view-validator" },
    {
      flat: `../../../types/generated/views/validators/${validatorFileBase}`,
    },
  );
  const mountPath = nestedMountPath(descriptor);
  const id = nestedIdFactory(options);
  const parent = id(1);
  const member = id(2);
  const otherMember = id(3);
  const otherParent = id(99);
  const collectionUrl = `${mountPath}/${parent.url}${descriptor.segment}`;
  const memberUrl = `${collectionUrl}/${member.url}`;
  const pk = primaryKeyMock(options, nestedRouterTestPath(descriptor, options));
  return `import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Application } from "express";
import request from "supertest";
${pk.importLine}

vi.mock("${validatorPath}", () => {
  const passthrough = { parse: (value: unknown) => value };
  return {
    create${childPascal}Schema: passthrough,
    update${childPascal}Schema: passthrough,
  };
});

import { ${fnName} } from "../${fileBase}";

${MOCK_FACTORY}
describe("${fnName}", () => {
  let service: any;
  let app: Application;

  beforeEach(() => {
    service = createMock(${pk.expr});
    app = express();
    app.use(express.json());
    app.use("${mountPath}", ${fnName}(service));
  });

  it("GET ${collectionUrl} filters service.findAll by ${descriptor.fkColumn}", async () => {
    service.findAll.mockResolvedValueOnce([
      { id: ${member.lit}, ${descriptor.fkColumn}: ${parent.lit} },
      { id: ${otherMember.lit}, ${descriptor.fkColumn}: ${otherParent.lit} },
    ]);
    const res = await request(app).get("${collectionUrl}");
    expect(res.status).toBe(200);
    expect(service.findAll).toHaveBeenCalled();
  });

  it("GET ${memberUrl} returns the row when its FK matches the parent", async () => {
    service.findAll.mockResolvedValueOnce([{ id: ${member.lit}, ${descriptor.fkColumn}: ${parent.lit} }]);
    const res = await request(app).get("${memberUrl}");
    expect(res.status).toBe(200);
  });

  it("GET ${memberUrl} returns 404 when the row's FK does not match the parent", async () => {
    service.findAll.mockResolvedValueOnce([{ id: ${member.lit}, ${descriptor.fkColumn}: ${otherParent.lit} }]);
    const res = await request(app).get("${memberUrl}");
    expect(res.status).toBe(404);
  });
});
`;
}

/** By-feature-aware generated path for a nested router test (`features/<entity>/__tests__/<plural>.integration.test.ts`). */
function nestedRouterTestPath(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteTestOptions,
): string {
  return layoutFor(options).testPath(nestedRouteEntity(descriptor), "route", {
    fileName: `${nestedRouterFileBase(descriptor, descriptorFileFormat(options))}.integration.test.ts`,
  });
}

export function generateNestedDirectFkRouterTest(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteTestOptions = {},
): GeneratedFile {
  if (descriptor.kind !== "direct-fk") {
    throw new Error(
      `generateNestedDirectFkRouterTest: expected direct-fk descriptor, got ${descriptor.kind}`,
    );
  }
  return {
    path: nestedRouterTestPath(descriptor, options),
    content: nestedDirectFkTestContent(descriptor, options),
  };
}

export function generateNestedM2mRouterTest(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteTestOptions = {},
): GeneratedFile {
  if (descriptor.kind !== "m2m") {
    throw new Error(
      `generateNestedM2mRouterTest: expected m2m descriptor, got ${descriptor.kind}`,
    );
  }
  return {
    path: nestedRouterTestPath(descriptor, options),
    content: nestedM2mTestContent(descriptor, options),
  };
}
