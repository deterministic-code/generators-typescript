import { describe, expect, it } from 'vitest';

import {
  packEagerRelation,
  parseRelationType,
  relationIsArray,
  unpackEagerRelation,
} from '../computeEagerChildren';

describe('parseRelationType', () => {
  it('parses a collection', () => {
    expect(parseRelationType('datasource_types.address[]')).toEqual({
      elementType: 'address',
      isArray: true,
    });
  });

  it('parses a singular nested object', () => {
    expect(parseRelationType('datasource_types.address')).toEqual({
      elementType: 'address',
      isArray: false,
    });
  });

  it('rejects missing, primitive, and dotted extras', () => {
    expect(parseRelationType(undefined)).toBeNull();
    expect(parseRelationType('string')).toBeNull();
    expect(parseRelationType('address[]')).toEqual({
      elementType: 'address',
      isArray: true,
    });
    expect(parseRelationType('datasource_types.address.contact_id')).toBeNull();
    expect(parseRelationType('datasource_types.')).toBeNull();
    expect(parseRelationType('datasource_types.[]')).toBeNull();
  });
});

describe('relationIsArray', () => {
  it('treats omitted and true as a collection', () => {
    expect(relationIsArray({})).toBe(true);
    expect(relationIsArray({ isArray: true })).toBe(true);
    expect(relationIsArray({ isArray: false })).toBe(false);
  });
});

describe('packEagerRelation', () => {
  const row = { id: 1, line1: 'x' };

  it('returns the list for a collection, including empty', () => {
    expect(packEagerRelation([row], true)).toEqual([row]);
    expect(packEagerRelation([], true)).toEqual([]);
  });

  it('returns the first row or null for a singular field', () => {
    expect(packEagerRelation([row, { id: 2 }], false)).toEqual(row);
    expect(packEagerRelation([], false)).toBeNull();
  });
});

describe('unpackEagerRelation', () => {
  const row = { line1: 'x' };

  it('unwraps a collection array and ignores a missing key', () => {
    expect(unpackEagerRelation([row], true)).toEqual([row]);
    expect(unpackEagerRelation([], true)).toEqual([]);
    expect(unpackEagerRelation(undefined, true)).toBeUndefined();
    expect(unpackEagerRelation(row, true)).toBeUndefined();
    expect(unpackEagerRelation(null, true)).toBeUndefined();
  });

  it('unwraps a singular object, treats null as clear, and ignores a missing key', () => {
    expect(unpackEagerRelation(row, false)).toEqual([row]);
    expect(unpackEagerRelation(null, false)).toEqual([]);
    expect(unpackEagerRelation(undefined, false)).toBeUndefined();
    expect(unpackEagerRelation([row], false)).toBeUndefined();
    expect(unpackEagerRelation('nope', false)).toBeUndefined();
  });
});
