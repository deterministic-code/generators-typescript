import npmPluralize from "pluralize";
import { toCase } from "../../sdk/case.ts";
import type { CaseFormat } from "../../sdk/case.ts";
import {
  DEFAULT_COMMENT_STYLE,
  renderDocComment,
  type CommentStyle,
} from "../../sdk/generate-doc-comment.ts";
import { libraryImportSpecifier } from "./library-import.ts";
import {
  routeServiceImport,
  routeValidatorImport,
} from "./generate-routes-typescript.ts";
import {
  namesFor,
  layoutFor,
  type NamesForOptions,
} from "../../sdk/codegen/lib/ts-codegen-naming.ts";
import { inferPkForCandidate } from "../../sdk/codegen/lib/infer-pk-for-candidate.ts";
import type { GeneratedFile } from "../../sdk/codegen/lib/routes-generate-types.ts";
import type {
  NestedRouteDescriptor,
  DirectFkDescriptor,
  M2mDescriptor,
} from "./nested-routes-generate-types.ts";

interface NestedRouteOptions extends NamesForOptions {
  libraryReferenceMode?: string;
  style?: CommentStyle;
  datasourceData?: unknown;
  datasourceSettings?: unknown;
}

interface InferredPk {
  column: string;
  idType: string;
}

interface ServiceImport {
  iface: string;
  import: string;
}

interface ValidatorImport {
  create: string;
  update: string;
  import: string;
}

const DEFAULT_FILE_FORMAT: CaseFormat = "Kebab";

/** The parent entity's primary key, generated so `createNestedCrudRouter` can parse the `/:<parentParam>` segment (the child key is read from the injected `service.primaryKey`). Resolved from the parent's declared `primary_key` + project settings; a direct-generate test that omits settings gets the integer `id` fallback baked into `inferPkForCandidate`. */
function parentPrimaryKeyExpr(
  descriptor: NestedRouteDescriptor,
  opts: NestedRouteOptions,
): string {
  const inferOptions = {
    withIdType: true,
    datasourceSettings: opts.datasourceSettings,
  };
  // inferPkForCandidate is an untyped JS module; its inferred options type drops datasourceSettings and its result widens to a nullable union.
  const pk = inferPkForCandidate(
    { name: descriptor.parent },
    opts.datasourceData,
    inferOptions as unknown as Parameters<typeof inferPkForCandidate>[2],
  ) as unknown as InferredPk;
  return `new PrimaryKey(${JSON.stringify(pk.column)}, ${JSON.stringify(pk.idType)})`;
}

function segmentTailSnake(descriptor: NestedRouteDescriptor): string {
  return descriptor.segmentTail.replace(/-/g, "_");
}

function stem(descriptor: NestedRouteDescriptor): string {
  return `nested_${descriptor.parent}_${segmentTailSnake(descriptor)}`;
}

export function nestedRouteEntity(descriptor: NestedRouteDescriptor): string {
  const parts = stem(descriptor).split("_");
  parts[parts.length - 1] = npmPluralize.singular(parts[parts.length - 1]);
  return parts.join("_");
}

export function descriptorFileFormat(options: NestedRouteOptions): CaseFormat {
  return options.fileFormat ?? DEFAULT_FILE_FORMAT;
}

export function nestedMountPath(descriptor: NestedRouteDescriptor): string {
  return descriptor.parentBasePath.replace(`/:${descriptor.parentParam}`, "");
}

function nestedGeneratePath(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteOptions,
  byFeature: boolean,
): string {
  const fileBase = nestedRouterFileBase(
    descriptor,
    descriptorFileFormat(options),
  );
  if (!byFeature) return `${fileBase}.ts`;
  return layoutFor(options).featurePath(
    nestedRouteEntity(descriptor),
    "route",
    `${fileBase}.ts`,
  );
}

export function nestedRouterFileBase(
  descriptor: NestedRouteDescriptor,
  fileFormat: CaseFormat = DEFAULT_FILE_FORMAT,
): string {
  // nested-router base `nested_<parent>_<tail>` has no CodegenNames artifact; fileFormat is the caller-resolved format.
  return toCase(stem(descriptor), fileFormat); // lint-generator-casing-allow: toCase
}

export function nestedRouterFnName(descriptor: NestedRouteDescriptor): string {
  // router FUNCTION symbol (mounted in app.ts, referenced by e2e tests) is camelCase regardless of classFormat.
  return `${toCase(stem(descriptor), "Camel")}Router`; // lint-generator-casing-allow: toCase
}

function serviceImport(
  typeName: string,
  opts: NestedRouteOptions,
  fromEntity: string,
): ServiceImport {
  const pascal = namesFor(opts).className(typeName);
  const importPath = routeServiceImport(opts, fromEntity, typeName);
  return {
    iface: `I${pascal}Service`,
    import: `import { I${pascal}Service } from "${importPath}";`,
  };
}

function validatorImport(
  typeName: string,
  opts: NestedRouteOptions,
  fromEntity: string,
): ValidatorImport {
  const pascal = namesFor(opts).className(typeName);
  const importPath = routeValidatorImport(opts, fromEntity, typeName);
  return {
    create: `create${pascal}Schema`,
    update: `update${pascal}Schema`,
    import: `import { create${pascal}Schema, update${pascal}Schema } from "${importPath}";`,
  };
}

function nestedRouterPreamble(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteOptions,
) {
  const fileFormat = descriptorFileFormat(options);
  const opts = { ...options, fileFormat };
  const byFeature = options.organizeByFeature === true;
  const fileBase = nestedRouterFileBase(descriptor, fileFormat);
  const generatePath = nestedGeneratePath(descriptor, options, byFeature);
  const routesImport = libraryImportSpecifier(
    "routes",
    options.libraryReferenceMode,
    byFeature ? generatePath : `routes/generated/${fileBase}.ts`,
  );
  const fnName = nestedRouterFnName(descriptor);
  const mountPath = nestedMountPath(descriptor);
  const doc = (datasourceType: string, target: string) =>
    renderDocComment({
      style: options.style ?? DEFAULT_COMMENT_STYLE,
      summary: `Route ${fnName}. Mount at "${mountPath}".`,
      lines: [
        `Datasource type: ${datasourceType}.`,
        `Target: ${target}.`,
        `Fields: 0.`,
      ],
    });
  return {
    opts,
    fromEntity: nestedRouteEntity(descriptor),
    fnName,
    parentPascal: namesFor(opts).className(descriptor.parent),
    routesImport,
    doc,
  };
}

function nestedDirectFkContent(
  descriptor: DirectFkDescriptor,
  options: NestedRouteOptions,
): string {
  const { opts, fromEntity, fnName, parentPascal, routesImport, doc } =
    nestedRouterPreamble(descriptor, options);
  const childPascal = namesFor(opts).className(descriptor.child.name);
  const childSvc = serviceImport(descriptor.child.name, opts, fromEntity);
  const validator = validatorImport(descriptor.child.name, opts, fromEntity);
  const repositoriesImport = libraryImportSpecifier(
    "repositories",
    opts.libraryReferenceMode,
    nestedGeneratePath(descriptor, options, options.organizeByFeature === true),
  );
  const docBlock = doc("nested-direct-fk", "NestedCrudRouter");
  return `import { Router } from "express";
import { createNestedCrudRouter } from "${routesImport}";
import { PrimaryKey } from "${repositoriesImport}";
${childSvc.import}
${validator.import}

${docBlock}export function ${fnName}(service: ${childSvc.iface}): Router {
  const router = Router({ mergeParams: true });
  router.use(
    "/:${descriptor.parentParam}${descriptor.segment}",
    createNestedCrudRouter({
      service,
      createSchema: ${validator.create},
      updateSchema: ${validator.update},
      parentParamName: "${descriptor.parentParam}",
      parentFkField: "${descriptor.fkColumn}",
      parentEntityName: "${parentPascal}",
      entityName: "${childPascal}",
      parentPrimaryKey: ${parentPrimaryKeyExpr(descriptor, opts)},
    }),
  );
  return router;
}
`;
}

function nestedM2mContent(
  descriptor: M2mDescriptor,
  options: NestedRouteOptions,
): string {
  const { opts, fromEntity, fnName, parentPascal, routesImport, doc } =
    nestedRouterPreamble(descriptor, options);
  const targetPascal = namesFor(opts).className(descriptor.target);
  const parentSvc = serviceImport(descriptor.parent, opts, fromEntity);
  const junctionSvc = serviceImport(descriptor.junction, opts, fromEntity);
  const targetSvc = serviceImport(descriptor.target, opts, fromEntity);
  const docBlock = doc("nested-m2m", "NestedManyToManyRouter");
  return `import { Router } from "express";
import { addNestedManyToManyRoutes } from "${routesImport}";
${parentSvc.import}
${junctionSvc.import}
${targetSvc.import}

${docBlock}export function ${fnName}(
  parentService: ${parentSvc.iface},
  junctionService: ${junctionSvc.iface},
  targetService: ${targetSvc.iface},
): Router {
  const router = Router({ mergeParams: true });
  addNestedManyToManyRoutes(router, {
    parentService,
    junctionService,
    childService: targetService,
    parentParamName: "${descriptor.parentParam}",
    parentEntityName: "${parentPascal}",
    childParamName: "${descriptor.targetParam}",
    childEntityName: "${targetPascal}",
    nestedPath: "${descriptor.segmentTail}",
    parentFkField: "${descriptor.parentFkField}",
    childFkField: "${descriptor.childFkField}",
    bodyFields: ["${descriptor.childFkField}"],
    linkVerb: "POST",
  });
  return router;
}
`;
}

export function generateNestedDirectFkRouter(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteOptions = {},
): GeneratedFile {
  if (descriptor.kind !== "direct-fk") {
    throw new Error(
      `generateNestedDirectFkRouter: expected direct-fk descriptor, got ${descriptor.kind}`,
    );
  }
  const byFeature = options.organizeByFeature === true;
  return {
    path: nestedGeneratePath(descriptor, options, byFeature),
    content: nestedDirectFkContent(descriptor, options),
  };
}

export function generateNestedM2mRouter(
  descriptor: NestedRouteDescriptor,
  options: NestedRouteOptions = {},
): GeneratedFile {
  if (descriptor.kind !== "m2m") {
    throw new Error(
      `generateNestedM2mRouter: expected m2m descriptor, got ${descriptor.kind}`,
    );
  }
  const byFeature = options.organizeByFeature === true;
  return {
    path: nestedGeneratePath(descriptor, options, byFeature),
    content: nestedM2mContent(descriptor, options),
  };
}
