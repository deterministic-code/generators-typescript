import { describe, expect, it } from 'vitest';

import { computeEagerChildren, type EagerLoadGate } from '../computeEagerChildren';

type ViewTypesDoc = Parameters<typeof computeEagerChildren>[1];
type DatasourceDoc = Parameters<typeof computeEagerChildren>[3];

const treeFor = (...fields: string[]): EagerLoadGate => {
  const m = new Map();
  for (const f of fields) m.set(f, new Map());
  return m;
};

describe('computeEagerChildren', () => {
  it('returns direct-FK array field match', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                posts: {
                  type: 'datasource_types.post[]',
                  references: 'datasource_types.post.author_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, '*')).toEqual([
      { fieldName: 'posts', childTable: 'post', refColumn: 'author_id' },
    ]);
  });

  it('skips M2M when no datasource doc is provided', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                tags: {
                  type: 'datasource_types.tag[]',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, '*')).toEqual([]);
  });

  it('matches M2M when the view field names a view type and the junction FKs name the inherited datasource', () => {
    const typesYaml: DatasourceDoc = {
      types: [
        {
          contacts_base: {
            tags: ['datasource_type'],
            fields: [{ first_name: { type: 'string' } }],
          },
        },
        {
          contact_groups_base: {
            tags: ['datasource_type'],
            fields: [{ name: { type: 'string' } }],
          },
        },
        {
          contact: {
            tags: ['view_type'],
            inherits: 'contacts_base',
            fields: [],
          },
        },
        {
          contact_group: {
            tags: ['view_type'],
            inherits: 'contact_groups_base',
            fields: [
              {
                members: {
                  type: 'contact[]',
                  references: 'contact_group_member.contact_group_id',
                },
              },
            ],
          },
        },
        {
          contact_group_member: {
            tags: ['datasource_type', 'many_to_many'],
            fields: [
              { contact_id: { type: 'integer', references: 'contacts_base.id' } },
              { contact_group_id: { type: 'integer', references: 'contact_groups_base.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact_group', typesYaml, '*', typesYaml)).toEqual([
      {
        fieldName: 'members',
        childTable: 'contact',
        refColumn: 'contact_group_id',
        joinTable: 'contact_group_member',
        joinChildColumn: 'contact_id',
      },
    ]);
  });

  it('emits M2M spec with joinTable + joinChildColumn when junction is in datasource doc', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                tags: {
                  type: 'datasource_types.tag[]',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          user_tag: {
            datasource_type: 'many-to-many',
            fields: [
              { user_id: { type: 'number', references: 'user.id' } },
              { tag_id: { type: 'number', references: 'tag.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, '*', datasourceDoc)).toEqual([
      {
        fieldName: 'tags',
        childTable: 'tag',
        refColumn: 'user_id',
        joinTable: 'user_tag',
        joinChildColumn: 'tag_id',
      },
    ]);
  });

  it('auto-detects M2M junction when reference is omitted on the view field', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          contact: {
            inherits: 'datasource_types.contact',
            fields: [
              {
                labels: {
                  type: 'datasource_types.label[]',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          contact_label: {
            datasource_type: 'many-to-many',
            fields: [
              { contact_id: { type: 'number', references: 'contact.id' } },
              { labels_id: { type: 'number', references: 'label.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact', doc, '*', datasourceDoc)).toEqual([
      {
        fieldName: 'labels',
        childTable: 'label',
        refColumn: 'contact_id',
        joinTable: 'contact_label',
        joinChildColumn: 'labels_id',
      },
    ]);
  });

  it('declines auto-detect when more than one M2M junction matches (ambiguous)', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          contact: {
            inherits: 'datasource_types.contact',
            fields: [
              {
                labels: { type: 'datasource_types.label[]' },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          contact_label_a: {
            datasource_type: 'many-to-many',
            fields: [
              { contact_id: { type: 'number', references: 'contact.id' } },
              { labels_id: { type: 'number', references: 'label.id' } },
            ],
          },
        },
        {
          contact_label_b: {
            datasource_type: 'many-to-many',
            fields: [
              { contact_id: { type: 'number', references: 'contact.id' } },
              { labels_id: { type: 'number', references: 'label.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact', doc, '*', datasourceDoc)).toEqual([]);
  });

  it('skips M2M when junction table is absent from datasource doc', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                tags: {
                  type: 'datasource_types.tag[]',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = { types: [] };
    expect(computeEagerChildren('user', doc, '*', datasourceDoc)).toEqual([]);
  });

  it('mixes direct-FK and M2M children on the same view type', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                posts: {
                  type: 'datasource_types.post[]',
                  references: 'datasource_types.post.author_id',
                },
              },
              {
                tags: {
                  type: 'datasource_types.tag[]',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          user_tag: {
            datasource_type: 'many-to-many',
            fields: [
              { user_id: { type: 'number', references: 'user.id' } },
              { tag_id: { type: 'number', references: 'tag.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, '*', datasourceDoc)).toEqual([
      { fieldName: 'posts', childTable: 'post', refColumn: 'author_id' },
      {
        fieldName: 'tags',
        childTable: 'tag',
        refColumn: 'user_id',
        joinTable: 'user_tag',
        joinChildColumn: 'tag_id',
      },
    ]);
  });

  it('includes only fields named in the tree gate', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                posts: {
                  type: 'datasource_types.post[]',
                  references: 'datasource_types.post.author_id',
                },
              },
              {
                tags: {
                  type: 'datasource_types.tag[]',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          user_tag: {
            datasource_type: 'many-to-many',
            fields: [
              { user_id: { type: 'number', references: 'user.id' } },
              { tag_id: { type: 'number', references: 'tag.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, treeFor('posts'), datasourceDoc)).toEqual([
      { fieldName: 'posts', childTable: 'post', refColumn: 'author_id' },
    ]);
  });

  it('returns empty when gate is null, undefined, or empty Map', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                posts: {
                  type: 'datasource_types.post[]',
                  references: 'datasource_types.post.author_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, null)).toEqual([]);
    expect(computeEagerChildren('user', doc, undefined)).toEqual([]);
    expect(computeEagerChildren('user', doc, new Map())).toEqual([]);
  });

  it('returns empty when entity has no view type', () => {
    const doc: ViewTypesDoc = {
      types: [{ user: { inherits: 'datasource_types.user', fields: [] } }],
    };
    expect(computeEagerChildren('application', doc, '*')).toEqual([]);
  });

  it('handles multiple array fields on one view type', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          application: {
            inherits: 'datasource_types.application',
            fields: [
              {
                settings: {
                  type: 'datasource_types.application_setting[]',
                  references: 'datasource_types.application_setting.application_id',
                },
              },
              {
                uris: {
                  type: 'datasource_types.application_uri[]',
                  references: 'datasource_types.application_uri.application_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('application', doc, '*')).toEqual([
      { fieldName: 'settings', childTable: 'application_setting', refColumn: 'application_id' },
      { fieldName: 'uris', childTable: 'application_uri', refColumn: 'application_id' },
    ]);
  });

  it('returns empty when doc is null or undefined', () => {
    expect(computeEagerChildren('user', null, '*')).toEqual([]);
    expect(computeEagerChildren('user', undefined, '*')).toEqual([]);
  });

  it('matches a singular nested datasource object (no [])', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          contact: {
            inherits: 'datasource_types.contact',
            fields: [
              {
                address: {
                  type: 'datasource_types.address',
                  references: 'datasource_types.address.contact_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact', doc, '*')).toEqual([
      { fieldName: 'address', childTable: 'address', refColumn: 'contact_id', isArray: false },
    ]);
  });

  it('keeps collection and singular flags when both fields are present', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          contact: {
            inherits: 'datasource_types.contact',
            fields: [
              {
                address: {
                  type: 'datasource_types.address',
                  references: 'datasource_types.address.contact_id',
                },
              },
              {
                phones: {
                  type: 'datasource_types.phone[]',
                  references: 'datasource_types.phone.contact_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact', doc, '*')).toEqual([
      { fieldName: 'address', childTable: 'address', refColumn: 'contact_id', isArray: false },
      { fieldName: 'phones', childTable: 'phone', refColumn: 'contact_id' },
    ]);
  });

  it('skips primitives and dotted type strings that are not a relation', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          contact: {
            inherits: 'datasource_types.contact',
            fields: [
              { display_name: { type: 'string' } },
              {
                bogus: {
                  type: 'datasource_types.address.contact_id',
                  references: 'datasource_types.address.contact_id',
                },
              },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('contact', doc, '*')).toEqual([]);
  });

  it('flags a singular M2M field', () => {
    const doc: ViewTypesDoc = {
      types: [
        {
          user: {
            inherits: 'datasource_types.user',
            fields: [
              {
                tag: {
                  type: 'datasource_types.tag',
                  references: 'datasource_types.user_tag.user_id',
                },
              },
            ],
          },
        },
      ],
    };
    const datasourceDoc: DatasourceDoc = {
      types: [
        {
          user_tag: {
            datasource_type: 'many-to-many',
            fields: [
              { user_id: { type: 'number', references: 'user.id' } },
              { tag_id: { type: 'number', references: 'tag.id' } },
            ],
          },
        },
      ],
    };
    expect(computeEagerChildren('user', doc, '*', datasourceDoc)).toEqual([
      {
        fieldName: 'tag',
        childTable: 'tag',
        refColumn: 'user_id',
        joinTable: 'user_tag',
        joinChildColumn: 'tag_id',
        isArray: false,
      },
    ]);
  });
});
