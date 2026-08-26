import { EntityIdentity } from '../EntityIdentity';
import { PrimaryKey } from '../PrimaryKey';
import type { IPrimaryKeyService } from '../IPrimaryKeyService';
import type { StandardIdType } from '../standardFieldConverting';

/** A stub {@link IPrimaryKeyService} for repo/service/router fixtures: every `forEntity` resolves to one fixed key. `idType` is explicit (no default) so a fixture states the shape it intends; `column` defaults to the structural `id`. */
export function testPrimaryKeys(idType: StandardIdType, column = 'id'): IPrimaryKeyService {
  const identity = EntityIdentity.scalar(column, idType);
  return { forEntity: () => identity };
}

export function testCompositeKeys(
  parts: ReadonlyArray<{ column: string; idType: StandardIdType }>,
): IPrimaryKeyService {
  const identity = EntityIdentity.of(parts.map((p) => new PrimaryKey(p.column, p.idType)));
  return { forEntity: () => identity };
}
