/** Boundary shapes the FK-seeding service-integration-test generators (typescript + rust) read out of the untyped `resolveServiceIntegrationTestSpec` / `resolveFkSeedPlan` / `classifyEntitySampleColumns` helpers. */

export interface IntegrationTestCandidate {
  name: string;
  kind: string;
}

export interface NamedField {
  name: string;
  type: string;
}

interface FkColumnBinding {
  column: string;
  parentTable: string;
}

interface LookupStep {
  kind: "lookup";
  table: string;
}

export interface CreateStep {
  kind: "create";
  table: string;
  scalars: Record<string, unknown>;
  fkColumns: FkColumnBinding[];
  nullFkColumns: string[];
}

export interface FkSeedPlan {
  needsSeed: boolean;
  steps: (LookupStep | CreateStep)[];
  stripOrder: string[];
  entityFkColumns: FkColumnBinding[];
  entityNullFkColumns: string[];
}

export interface ResolvedSpec {
  entityName: string;
  className: string;
  tableName: string;
  sample: Record<string, unknown>;
  findByField: NamedField | null;
  updateField: NamedField | null;
  updatedValue: string | null;
  fkSeedPlan: FkSeedPlan;
}

export type ClassifiedColumn =
  | { column: string; kind: "fk"; parentTable: string }
  | { column: string; kind: "null" }
  | { column: string; kind: "literal"; value: unknown };
