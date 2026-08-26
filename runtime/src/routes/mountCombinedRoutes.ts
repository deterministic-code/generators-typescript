import type { Express } from 'express';
import type { ZodSchema } from 'zod';
import { IEntityService } from '../services/interfaces/IEntityService';
import { createNestedCrudRouter } from './createNestedCrudRouter';
import { addNestedManyToManyRoutes } from './nestedManyToManyRoutes';
import {
  iterateCombinedRoutes,
  findForeignKeyTo,
  snakeToCamel,
  type DatasourceData,
  type RoutesData,
  type CombinedRouteDescriptor,
  type DatasourceTypeDef,
} from './iterateCombinedRoutes';
import { Router } from 'express';

export interface MountCombinedRoutesOptions {
  /** Map of camelCase service key (e.g. "appSettingService") → entity service. */
  repos: Record<string, IEntityService<any, any>>;
  /**
   * Optional map of entity name → eager-loading-wrapped read service. When a
   * child entity has a wrapped service, combined-route GET handlers use it so
   * subpath responses include the same eager-loaded relations as the top-level
   * CRUD routes.
   */
  fullReadServices?: Map<string, IEntityService<any, any>>;
  datasourceData: DatasourceData;
  routesData: RoutesData;
  /** Builds the create-body Zod schema for a direct-fk child entity (typeName). */
  buildCreateSchema: (typeName: string) => ZodSchema;
  /** Builds the update-body Zod schema for a direct-fk child entity (typeName). */
  buildUpdateSchema: (typeName: string) => ZodSchema;
}

function serviceKeyFor(typeName: string): string {
  return `${snakeToCamel(typeName)}Service`;
}

function pascal(typeName: string): string {
  const camel = snakeToCamel(typeName);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function indexDatasource(data: DatasourceData): Map<string, DatasourceTypeDef> {
  const byName = new Map<string, DatasourceTypeDef>();
  for (const entry of data.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    byName.set(name, def);
  }
  return byName;
}

function requireService(
  repos: Record<string, IEntityService<any, any>>,
  typeName: string,
): IEntityService<any, any> {
  const key = serviceKeyFor(typeName);
  const svc = repos[key];
  if (!svc) {
    throw new Error(`mountCombinedRoutes: service "${key}" not found in repos`);
  }
  return svc;
}

function readServiceFor(
  options: MountCombinedRoutesOptions,
  typeName: string,
): IEntityService<any, any> {
  return options.fullReadServices?.get(typeName) ?? requireService(options.repos, typeName);
}

interface FkRow {
  id: number;
  [key: string]: unknown;
}

function mountDirectFk(
  app: Express,
  descriptor: Extract<CombinedRouteDescriptor, { kind: 'direct-fk' }>,
  options: MountCombinedRoutesOptions,
): void {
  const childTypeName = descriptor.child.name;
  const childService = readServiceFor(options, childTypeName) as IEntityService<any, any>;
  const parentService = requireService(options.repos, descriptor.parent);
  const router = createNestedCrudRouter<FkRow>({
    service: childService,
    createSchema: options.buildCreateSchema(childTypeName),
    updateSchema: options.buildUpdateSchema(childTypeName),
    parentParamName: descriptor.parentParam,
    parentFkField: descriptor.fkColumn as keyof FkRow & string,
    parentEntityName: pascal(descriptor.parent),
    entityName: pascal(childTypeName),
    parentPrimaryKey: parentService.primaryKey,
  });
  app.use(descriptor.collectionPath, router);
}

function mountM2m(
  app: Express,
  descriptor: Extract<CombinedRouteDescriptor, { kind: 'm2m' }>,
  ctx: {
    options: MountCombinedRoutesOptions;
    datasourceByName: Map<string, DatasourceTypeDef>;
  },
): void {
  const { options, datasourceByName } = ctx;
  const junctionDef = datasourceByName.get(descriptor.junction);
  if (!junctionDef) {
    throw new Error(
      `mountCombinedRoutes: junction "${descriptor.junction}" missing from datasource_types`,
    );
  }
  const parentFkField = findForeignKeyTo(junctionDef, descriptor.parent, datasourceByName);
  const childFkField = findForeignKeyTo(junctionDef, descriptor.target, datasourceByName);
  if (!parentFkField || !childFkField) {
    throw new Error(
      `mountCombinedRoutes: junction "${descriptor.junction}" missing FK to ${descriptor.parent}/${descriptor.target}`,
    );
  }

  const parentService = requireService(options.repos, descriptor.parent) as IEntityService<
    any,
    any
  >;
  const junctionService = requireService(
    options.repos,
    descriptor.junction,
  ) as IEntityService<any, any>;
  const childService = readServiceFor(options, descriptor.target);

  const router = Router({ mergeParams: true });
  addNestedManyToManyRoutes<FkRow, FkRow>(router, {
    parentService,
    junctionService,
    childService,
    parentParamName: descriptor.parentParam,
    parentEntityName: pascal(descriptor.parent),
    childParamName: descriptor.targetParam,
    childEntityName: pascal(descriptor.target),
    nestedPath: descriptor.segmentTail,
    parentFkField: parentFkField as keyof FkRow & string,
    childFkField: childFkField as keyof FkRow & string,
    bodyFields: [childFkField as keyof FkRow & string],
    linkVerb: 'POST',
  });
  // addNestedManyToManyRoutes registers /:parentParam/<nestedPath>, so mount on the prefix preceding the parent id segment.
  const mountPath = descriptor.parentBasePath.replace(`/:${descriptor.parentParam}`, '');
  app.use(mountPath, router);
}

export function mountCombinedRoutes(app: Express, options: MountCombinedRoutesOptions): void {
  const datasourceByName = indexDatasource(options.datasourceData);

  for (const descriptor of iterateCombinedRoutes({
    routesData: options.routesData,
    datasourceData: options.datasourceData,
  })) {
    if (descriptor.kind === 'direct-fk') {
      mountDirectFk(app, descriptor, options);
    } else {
      mountM2m(app, descriptor, { options, datasourceByName });
    }
  }
}
