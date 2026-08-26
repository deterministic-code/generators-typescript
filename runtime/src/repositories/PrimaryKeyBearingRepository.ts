import type { EntityIdentity } from './EntityIdentity';
import type { IPrimaryKeyService } from './IPrimaryKeyService';

/**
 * Base for the hand-rolled dialect repositories (oracle, sqlserver) that resolve
 * their {@link EntityIdentity} from the injected {@link IPrimaryKeyService} instead of
 * hardcoding `id`. Owns the two members every such repo exposes so no dialect
 * re-declares the fields or re-derives the key.
 */
export abstract class PrimaryKeyBearingRepository {
  readonly entityName: string;
  readonly primaryKey: EntityIdentity;

  protected constructor(entityName: string, primaryKeys: IPrimaryKeyService) {
    this.entityName = entityName;
    this.primaryKey = primaryKeys.forEntity(entityName);
  }
}

interface QueryableDatasource {
  query<R = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<R[]>;
}

/**
 * A {@link PrimaryKeyBearingRepository} that also wraps a dialect datasource and
 * exposes the pass-through `query` every standalone `*StandardRepository` shares,
 * so neither the oracle nor sqlserver repo re-declares `datasource` or re-implements
 * the identical delegating method.
 */
export abstract class DatasourceBackedRepository<
  TDatasource extends QueryableDatasource,
> extends PrimaryKeyBearingRepository {
  protected constructor(
    protected readonly datasource: TDatasource,
    entityName: string,
    primaryKeys: IPrimaryKeyService,
  ) {
    super(entityName, primaryKeys);
  }

  async query<R = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<R[]> {
    return this.datasource.query<R>(sql, params);
  }
}
