import type {
  GeneratedFile,
  ServiceTestsGenerateConfig,
} from "../../sdk/codegen/lib/service-tests-generate-types.ts";
import {
  generateServiceTestsFiles,
  dispatchServiceTestsStep,
  servicesStepGenerate,
} from "../../sdk/codegen/lib/services-generate.ts";
import { joinImport, libraryImportSpecifier } from "./library-import.ts";
import {
  layoutFor,
  namesFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { sampleIdFactory } from "./route-test-sample-id.ts";

interface PrimaryKeyInfo {
  column: string;
  idType: string;
}

interface ServiceTestCandidate {
  name: string;
  primaryKey: PrimaryKeyInfo;
}

interface TsTestGenerateOptions extends NamesForOptions {
  schemaVersion?: string;
  servicePath?: string;
  libraryReferenceMode?: string;
}

export const DEFAULT_GENERATE_OPTIONS = {
  schemaVersion: "1.0",
  servicePath: "..",
  fileFormat: "Camel",
} as const;

export function generateGenericServiceTest(
  candidate: ServiceTestCandidate,
  opts: TsTestGenerateOptions = DEFAULT_GENERATE_OPTIONS,
): GeneratedFile {
  const names = namesFor(opts);
  const className = names.className(candidate.name, "service");
  const fileBase = names.fileBase(candidate.name, "service");
  const servicePath = opts.servicePath ?? DEFAULT_GENERATE_OPTIONS.servicePath;
  const importPath = joinImport(servicePath, fileBase);
  const path = layoutFor(opts).testPath(candidate.name, "service", {
    fileName: `${fileBase}.test.ts`,
  });
  const repositoriesImport = libraryImportSpecifier(
    "repositories",
    opts.libraryReferenceMode,
    opts.organizeByFeature
      ? path
      : `services/generated/__tests__/${fileBase}.test.ts`,
  );
  const pk = candidate.primaryKey;
  const sampleId = sampleIdFactory(pk.idType);
  const idLit = (n: number) => sampleId(n).lit;
  const pkExpr = `new PrimaryKey(${JSON.stringify(pk.column)}, ${JSON.stringify(pk.idType)})`;

  const content = `import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ICrudRepository } from "${repositoriesImport}";
import { PrimaryKey } from "${repositoriesImport}";
import { ${className} } from "${importPath}";

type Repo = ICrudRepository<any>;

function createMockRepository(): Repo {
  return {
    entityName: ${JSON.stringify(candidate.name)},
    primaryKey: ${pkExpr},
    query: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
    findBy: vi.fn().mockResolvedValue([]),
    findIn: vi.fn().mockResolvedValue([]),
    add: vi.fn(async (data: unknown) => ({ id: 1, ...(data as object) })),
    update: vi.fn(async (id: number, data: unknown) => ({ id, ...(data as object) })),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as Repo;
}

describe("${className}", () => {
  let repo: Repo;
  let service: ${className};

  beforeEach(() => {
    repo = createMockRepository();
    service = new ${className}(repo);
  });

  it("findAll delegates to the repository", async () => {
    await service.findAll();
    expect(repo.findAll).toHaveBeenCalledOnce();
  });

  it("findById forwards the id to repo.find", async () => {
    await service.findById(${idLit(42)});
    expect(repo.find).toHaveBeenCalledWith(${idLit(42)});
  });

  it("create forwards the payload to repo.add", async () => {
    const payload = { name: "example" } as any;
    await service.create(payload);
    expect(repo.add).toHaveBeenCalledWith(payload);
  });

  it("update forwards id + patch", async () => {
    const patch = { name: "renamed" } as any;
    await service.update(${idLit(7)}, patch);
    expect(repo.update).toHaveBeenCalledWith(${idLit(7)}, patch);
  });

  it("delete forwards the id", async () => {
    await service.delete(${idLit(9)});
    expect(repo.delete).toHaveBeenCalledWith(${idLit(9)});
  });

  it("findBy translates a single NameValue to repo.findBy", async () => {
    await service.findBy([{ name: "email", value: "a@b.c" }]);
    expect(repo.findBy).toHaveBeenCalledWith("email", "a@b.c");
  });
});
`;

  return { path, content };
}

/** Catalog `service_tests` step (typescript). */
export const generate = (ctx: unknown) =>
  servicesStepGenerate(
    {
      dispatchStep: dispatchServiceTestsStep,
      generator: { createGenerator },
      language: "typescript",
    },
    ctx,
  );

export const createGenerator = () => ({
  generate: (config: ServiceTestsGenerateConfig) =>
    generateServiceTestsFiles({
      ...config,
      primitives: {
        generateGenericServiceTest,
        defaultGenerateOptions: DEFAULT_GENERATE_OPTIONS,
      },
    }),
});
