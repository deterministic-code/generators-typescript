import { EntityIdentity } from './EntityIdentity';
import { PrimaryKey } from './PrimaryKey';
import type { StandardIdType } from './standardFieldConverting';
import type { IPrimaryKeyService } from './IPrimaryKeyService';

export interface PrimaryKeyColumnSpec {
  column: string;
  idType: StandardIdType;
}

/**
 * One entry per entity, fully resolved by the settings loader
 * (`parseCrudRouteSpecs`): the column (declared custom PK, else implicit `id`)
 * and its id_type (the custom PK's own type, else the project id_type from
 * settings). No literal defaults live here — both fields arrive already resolved.
 * `primaryKeyColumns` is the full identity when the entity authors `ids: [...]`.
 */
export interface PrimaryKeyRegistration {
  entityName: string;
  primaryKeyColumn: string;
  primaryKeyIdType: StandardIdType;
  primaryKeyColumns?: readonly PrimaryKeyColumnSpec[];
}

export class PrimaryKeyService implements IPrimaryKeyService {
  private readonly byEntity: Map<string, EntityIdentity>;

  constructor(registrations: readonly PrimaryKeyRegistration[]) {
    this.byEntity = new Map(
      registrations.map((r) => [
        r.entityName,
        EntityIdentity.of(
          (r.primaryKeyColumns ?? [
            { column: r.primaryKeyColumn, idType: r.primaryKeyIdType },
          ]).map((part) => new PrimaryKey(part.column, part.idType)),
        ),
      ]),
    );
  }

  forEntity(entityName: string): EntityIdentity {
    const pk = this.byEntity.get(entityName);
    if (!pk) {
      throw new Error(`invariant: no primary key registered for entity "${entityName}"`);
    }
    return pk;
  }
}
