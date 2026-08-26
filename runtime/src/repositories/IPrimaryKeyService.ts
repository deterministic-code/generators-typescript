import type { EntityIdentity } from './EntityIdentity';

/**
 * The one authority that resolves an entity's {@link EntityIdentity} (one or
 * more columns + id_types) from the contract/settings. Constructed once at the
 * composition root and injected — via constructor — into repos, services, and
 * routers, so no component re-derives or hardcodes a primary key.
 */
export interface IPrimaryKeyService {
  /** The identity for `entityName`. Throws if the entity was never registered (surfaces a non-settings-driven path). */
  forEntity(entityName: string): EntityIdentity;
}
