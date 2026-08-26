import { describe, expect, it } from 'vitest';

import { computeEnrichments, enrichmentsFromCrudSpec } from '../computeEnrichments';

type Doc = Parameters<typeof computeEnrichments>[1];

describe('computeEnrichments', () => {
  it('enriches FK to readonly-lookup target', () => {
    const doc: Doc = {
      types: [
        {
          color: {
            datasource_type: 'readonly-lookup',
            fields: [{ name: { type: 'string', is_unique: true } }],
          },
        },
        {
          widget: {
            fields: [
              { color_id: { type: 'number', references: 'color.id' } },
              { label: { type: 'string' } },
            ],
          },
        },
      ],
    };
    expect(computeEnrichments('widget', doc)).toEqual([
      { fkColumn: 'color_id', newField: 'color_name', targetTable: 'color' },
    ]);
  });

  it('enriches FK to non-lookup target with unique non-null name column', () => {
    const doc: Doc = {
      types: [
        {
          application: {
            fields: [{ name: { type: 'string', is_unique: true, is_nullable: false } }],
          },
        },
        {
          scope: {
            fields: [{ application_id: { type: 'number', references: 'application.id' } }],
          },
        },
      ],
    };
    expect(computeEnrichments('scope', doc)).toEqual([
      { fkColumn: 'application_id', newField: 'application_name', targetTable: 'application' },
    ]);
  });

  it('skips FK whose target has no unique-non-null name column', () => {
    const doc: Doc = {
      types: [
        { user: { fields: [{ email: { type: 'string', is_unique: true } }] } },
        {
          post: {
            fields: [{ user_id: { type: 'number', references: 'user.id' } }],
          },
        },
      ],
    };
    expect(computeEnrichments('post', doc)).toEqual([]);
  });

  it('skips FK whose name column is nullable', () => {
    const doc: Doc = {
      types: [
        {
          tag: {
            fields: [{ name: { type: 'string', is_unique: true, is_nullable: true } }],
          },
        },
        { item: { fields: [{ tag_id: { type: 'number', references: 'tag.id' } }] } },
      ],
    };
    expect(computeEnrichments('item', doc)).toEqual([]);
  });

  it('skips columns not ending in _id', () => {
    const doc: Doc = {
      types: [
        {
          color: {
            datasource_type: 'readonly-lookup',
            fields: [{ name: { type: 'string', is_unique: true } }],
          },
        },
        { widget: { fields: [{ color: { type: 'number', references: 'color.id' } }] } },
      ],
    };
    expect(computeEnrichments('widget', doc)).toEqual([]);
  });

  it('returns multiple enrichments for one entity', () => {
    const doc: Doc = {
      types: [
        {
          application_type: {
            datasource_type: 'readonly-lookup',
            fields: [{ name: { type: 'string', is_unique: true } }],
          },
        },
        {
          application_visibility: {
            datasource_type: 'readonly-lookup',
            fields: [{ name: { type: 'string', is_unique: true } }],
          },
        },
        {
          application: {
            fields: [
              { application_type_id: { type: 'number', references: 'application_type.id' } },
              {
                application_visibility_id: {
                  type: 'number',
                  references: 'application_visibility.id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEnrichments('application', doc)).toEqual([
      {
        fkColumn: 'application_type_id',
        newField: 'application_type_name',
        targetTable: 'application_type',
      },
      {
        fkColumn: 'application_visibility_id',
        newField: 'application_visibility_name',
        targetTable: 'application_visibility',
      },
    ]);
  });

  it('enrichmentsFromCrudSpec maps flattened enrichment columns onto FK references', () => {
    expect(
      enrichmentsFromCrudSpec({
        enrichmentColumns: ['contact_source_name'],
        fields: [
          { name: 'first_name' },
          { name: 'contact_source_id', references: 'contact_source.id' },
        ],
      }),
    ).toEqual([
      {
        fkColumn: 'contact_source_id',
        newField: 'contact_source_name',
        targetTable: 'contact_source',
      },
    ]);
  });

  it('returns empty when entity not found in doc', () => {
    expect(computeEnrichments('missing', { types: [] })).toEqual([]);
    expect(computeEnrichments('missing', null)).toEqual([]);
    expect(computeEnrichments('missing', undefined)).toEqual([]);
  });
});
