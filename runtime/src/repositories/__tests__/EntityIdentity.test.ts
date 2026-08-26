import { EntityIdentity } from '../EntityIdentity';
import { PrimaryKey } from '../PrimaryKey';

describe('EntityIdentity', () => {
  it('exposes the first key as column and idType', () => {
    const identity = EntityIdentity.of([
      new PrimaryKey('left_id', 'integer'),
      new PrimaryKey('right_id', 'integer'),
    ]);
    expect(identity.column).toBe('left_id');
    expect(identity.idType).toBe('integer');
    expect(identity.isComposite).toBe(true);
    expect(identity.columns()).toEqual(['left_id', 'right_id']);
    expect(identity.routeSegments()).toBe('/:left_id/:right_id');
  });

  it('normalizes a scalar onto the only column', () => {
    const identity = EntityIdentity.scalar('id', 'integer');
    expect(identity.normalize(7)).toEqual({ id: 7 });
    expect(identity.matches({ id: 7 }, 7)).toBe(true);
    expect(identity.matches({ id: 7 }, 8)).toBe(false);
  });

  it('requires a named record for a composite identity', () => {
    const identity = EntityIdentity.of([
      new PrimaryKey('left_id', 'integer'),
      new PrimaryKey('right_id', 'integer'),
    ]);
    expect(() => identity.normalize(1)).toThrow(/named record/);
    expect(identity.normalize({ left_id: 1, right_id: 2 })).toEqual({
      left_id: 1,
      right_id: 2,
    });
    expect(() => identity.normalize({ left_id: 1 })).toThrow(/missing identity key "right_id"/);
    expect(() => identity.normalize({ left_id: 1, right_id: 2, extra: 3 })).toThrow(
      /unexpected identity key/,
    );
  });

  it('reads and matches a composite row', () => {
    const identity = EntityIdentity.of([
      new PrimaryKey('left_id', 'integer'),
      new PrimaryKey('right_id', 'integer'),
    ]);
    const row = { left_id: 1, right_id: 2, name: 'edge' };
    expect(identity.fromRow(row)).toEqual({ left_id: 1, right_id: 2 });
    expect(identity.matches(row, { left_id: 1, right_id: 2 })).toBe(true);
    expect(identity.matches(row, { left_id: 1, right_id: 9 })).toBe(false);
    expect(identity.format({ left_id: 1, right_id: 2 })).toBe('1/2');
  });
});
