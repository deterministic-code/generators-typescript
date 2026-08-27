import { describe, it, expect } from 'vitest';
import { getMappedTableName } from '../getMappedTableName';

describe('getMappedTableName', () => {
  it('returns source when datasource_mappings entry exists for the entity', () => {
    const spec = {
      types: [
        {
          notification: {
            fields: [{ key: { type: 'string' } }],
          },
        },
      ],
      datasource_mappings: [
        {
          notification: {
            source: 'notifications',
          },
        },
      ],
    };
    const result = getMappedTableName(spec, 'notification');
    expect(result).toBe('notifications');
  });

  it('returns entity name when no mapping exists', () => {
    const spec = {
      types: [
        {
          notification: {
            fields: [{ key: { type: 'string' } }],
          },
        },
      ],
    };
    const result = getMappedTableName(spec, 'notification');
    expect(result).toBe('notification');
  });

  it('returns entity name when datasource_mappings exists but has no entry for the entity', () => {
    const spec = {
      types: [
        {
          notification: {
            fields: [{ key: { type: 'string' } }],
          },
        },
      ],
      datasource_mappings: [
        {
          other_type: {
            source: 'other_table',
          },
        },
      ],
    };
    const result = getMappedTableName(spec, 'notification');
    expect(result).toBe('notification');
  });

  it('returns entity name when datasource_mappings entry has no source (only field_mappings)', () => {
    const spec = {
      types: [
        {
          notification: {
            fields: [{ key: { type: 'string' } }, { name: { type: 'string' } }],
          },
        },
      ],
      datasource_mappings: [
        {
          notification: {
            field_mappings: [{ key: { source: 'Key' } }],
          },
        },
      ],
    };
    const result = getMappedTableName(spec, 'notification');
    expect(result).toBe('notification');
  });

  it('follows inherits to a parent overlay mapping (contact → contacts_base → contacts)', () => {
    const overlays = {
      types: [{ contacts_base: { mapping: 'contacts' } }, { contact_groups_base: { mapping: 'contact_groups' } }],
    };
    const types = {
      types: [
        { contacts_base: { tags: ['datasource_type'] } },
        { contact: { tags: ['view_type'], inherits: 'contacts_base' } },
        { contact_groups_base: { tags: ['datasource_type'] } },
        { contact_group: { tags: ['view_type'], inherits: 'contact_groups_base' } },
      ],
    };
    expect(getMappedTableName(overlays, 'contact', false, types)).toBe('contacts');
    expect(getMappedTableName(overlays, 'contact', true, types)).toBe('contacts');
    expect(getMappedTableName(overlays, 'contact_group', false, types)).toBe('contact_groups');
  });

  it('does not invent a mapping when the inherit chain has none', () => {
    const types = {
      types: [{ contact: { tags: ['view_type'], inherits: 'contacts_base' } }],
    };
    expect(getMappedTableName({}, 'contact', false, types)).toBe('contact');
    expect(getMappedTableName({}, 'contact', true, types)).toBe('contacts');
  });
});
