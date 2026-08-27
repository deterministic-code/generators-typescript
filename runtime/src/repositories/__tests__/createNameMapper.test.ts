import { describe, it, expect } from 'vitest';
import { createNameMapper, resolveFieldConverters } from '../createNameMapper';
import type { ITypeFieldConverter } from '../../converters/ITypeFieldConverter';

const stubConverter: ITypeFieldConverter<string, string> = {
  fromDatasource: 'sqlite',
  toLanguage: 'typescript',
  datasourceType: 'string',
  to: (value) => value,
  from: (value) => value,
};

const spec = {
  datasource_mappings: [
    {
      user: {
        source: 'users_table',
        field_mappings: [
          { email: { source: 'EMAIL', type_converter: 'lowercaseEmail' } },
          { handle: { source: 'Handle' } },
          { nickname: { type_converter: 'trimmed' } },
        ],
      },
    },
  ],
};

describe('createNameMapper', () => {
  it('resolves the mapped table name for an entity', () => {
    expect(createNameMapper(spec).tableFor('user')).toBe('users_table');
  });

  it('falls back to the entity name (optionally pluralized) when unmapped', () => {
    expect(createNameMapper(spec).tableFor('widget')).toBe('widget');
    expect(createNameMapper(spec, true).tableFor('widget')).toBe('widgets');
  });

  it('exposes logical→physical field renames', () => {
    const fields = createNameMapper(spec).fieldsFor('user');
    expect(fields.get('email')).toBe('EMAIL');
    expect(fields.get('handle')).toBe('Handle');
    expect(fields.has('nickname')).toBe(false);
  });

  it('exposes per-field type_converter names', () => {
    const converters = createNameMapper(spec).convertersFor('user');
    expect(converters.get('email')).toBe('lowercaseEmail');
    expect(converters.get('nickname')).toBe('trimmed');
    expect(converters.has('handle')).toBe(false);
  });

  it('returns empty maps for an entity with no mappings', () => {
    const mapper = createNameMapper(spec);
    expect(mapper.fieldsFor('widget').size).toBe(0);
    expect(mapper.convertersFor('widget').size).toBe(0);
  });

  it('inherits table and field mappings from the parent datasource type', () => {
    const overlays = {
      types: [
        {
          contacts_base: {
            mapping: 'contacts',
            fields: [{ first_name: { mapping: 'FirstNm' } }],
          },
        },
      ],
    };
    const types = {
      types: [{ contact: { inherits: 'contacts_base' } }],
    };
    const mapper = createNameMapper(overlays, false, types);
    expect(mapper.tableFor('contact')).toBe('contacts');
    expect(mapper.fieldsFor('contact').get('first_name')).toBe('FirstNm');
  });

  it('walks two inherit hops to the mapped table when pluralize is off', () => {
    const overlays = {
      types: [{ contacts_base: { mapping: 'contacts' } }, { contact_groups_base: { mapping: 'contact_groups' } }],
    };
    const types = {
      types: [
        { base: { tags: ['datasource_type'] } },
        { contacts_base: { tags: ['datasource_type'], inherits: 'base' } },
        { contact_groups_base: { tags: ['datasource_type'], inherits: 'base' } },
        { contact: { tags: ['view_type'], inherits: 'contacts_base' } },
        { contact_group: { tags: ['view_type'], inherits: 'contact_groups_base' } },
      ],
    };
    const mapper = createNameMapper(overlays, false, types);
    expect(mapper.tableFor('contact')).toBe('contacts');
    expect(mapper.tableFor('contact_group')).toBe('contact_groups');
  });
});

describe('resolveFieldConverters', () => {
  it('returns undefined when no field declares a converter', () => {
    expect(resolveFieldConverters(new Map(), new Map(), 'user')).toBeUndefined();
  });

  it('resolves each converter name against the supplied custom map', () => {
    const names = new Map([['email', 'lowercaseEmail']]);
    const custom = new Map([['lowercaseEmail', stubConverter]]);
    const resolved = resolveFieldConverters(names, custom, 'user')!;
    expect(resolved.get('email')).toBe(stubConverter);
  });

  it('throws when a declared converter name was not supplied (no silent drop)', () => {
    const names = new Map([['email', 'lowercaseEmail']]);
    expect(() => resolveFieldConverters(names, new Map(), 'user')).toThrow(
      /field 'email' declares type_converter 'lowercaseEmail'/,
    );
  });

  it('throws when customConverters is undefined but a converter is declared', () => {
    const names = new Map([['email', 'lowercaseEmail']]);
    expect(() => resolveFieldConverters(names, undefined, 'user')).toThrow(
      /no converter with that name was supplied/,
    );
  });
});
