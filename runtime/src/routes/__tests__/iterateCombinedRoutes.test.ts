import {
  iterateCombinedRoutes,
  findForeignKeyTo,
  snakeToCamel,
  type DatasourceData,
  type RoutesData,
  type CombinedRouteDescriptor,
  type DatasourceTypeDef,
  type DirectFkDescriptor,
  type M2mDescriptor,
} from '../iterateCombinedRoutes';

function field(
  name: string,
  def: Record<string, unknown>,
): Record<string, { [k: string]: unknown }> {
  return { [name]: def };
}

function expectOrgTagM2m(desc: M2mDescriptor): void {
  expect(desc.kind).toBe('m2m');
  expect(desc.junction).toBe('org_tag');
  expect(desc.target).toBe('tag');
}

const datasourceData: DatasourceData = {
  types: [
    { organization: { fields: [] } },
    {
      project: {
        fields: [
          field('id', { type: 'integer' }),
          field('organization_id', { references: 'organization.id' }),
        ],
      },
    },
    { tag: {} },
    {
      org_tag: {
        fields: [
          field('organization_id', { references: 'organization.id' }),
          field('tag_id', { references: 'tag.id' }),
        ],
      },
    },
    { widget: { fields: [] } },
    { member: { fields: [] } },
    {
      membership_a: {
        fields: [
          field('organization_id', { references: 'organization.id' }),
          field('member_id', { references: 'member.id' }),
        ],
      },
    },
    {
      membership_b: {
        fields: [
          field('organization_id', { references: 'organization.id' }),
          field('member_id', { references: 'member.id' }),
        ],
      },
    },
  ],
};

function collect(routesData: RoutesData): CombinedRouteDescriptor[] {
  return [...iterateCombinedRoutes({ routesData, datasourceData })];
}

describe('findForeignKeyTo', () => {
  it('returns the fk column when a field references the parent table', () => {
    const projectDef = datasourceData.types![1].project;
    expect(findForeignKeyTo(projectDef, 'organization')).toBe('organization_id');
  });

  it('returns null when the child has no fields array', () => {
    expect(findForeignKeyTo({ datasource_type: 'tag' }, 'organization')).toBeNull();
  });

  it('returns null when no field references the parent table', () => {
    const projectDef = datasourceData.types![1].project;
    expect(findForeignKeyTo(projectDef, 'nonexistent')).toBeNull();
  });

  it('walks view inherits so a base-table FK matches the view parent', () => {
    const byName = new Map<string, DatasourceTypeDef>([
      ['contacts_base', { fields: [] }],
      ['contact', { inherits: 'contacts_base', fields: [] }],
      [
        'addresses_base',
        { fields: [field('contact_id', { references: 'contacts_base.id' })] },
      ],
      ['address', { inherits: 'addresses_base', fields: [] }],
    ]);
    expect(findForeignKeyTo(byName.get('address')!, 'contact', byName)).toBe('contact_id');
  });
});

describe('iterateCombinedRoutes descriptors', () => {
  it('yields a direct-fk descriptor for a string child with a default segment', () => {
    const routesData: RoutesData = {
      combined_routes: [
        { organization: { route: '/organizations/{id}', combined_types: ['project'] } },
      ],
    };
    const [desc] = collect(routesData) as DirectFkDescriptor[];
    expect(desc.kind).toBe('direct-fk');
    expect(desc.parent).toBe('organization');
    expect(desc.parentBasePath).toBe('/organizations/:organizationId');
    expect(desc.parentParam).toBe('organizationId');
    expect(desc.child).toEqual({ name: 'project' });
    expect(desc.fkColumn).toBe('organization_id');
    expect(desc.segment).toBe('/projects');
    expect(desc.segmentTail).toBe('projects');
    expect(desc.collectionPath).toBe('/organizations/:organizationId/projects');
    expect(desc.memberPath).toBe('/organizations/:organizationId/projects/:id');
  });

  it('reads authored `combines` the same as legacy `combined_types`', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combines: [{ project: { route: '/deliverables' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as DirectFkDescriptor[];
    expect(desc.kind).toBe('direct-fk');
    expect(desc.collectionPath).toBe('/organizations/:organizationId/deliverables');
    expect(desc.segment).toBe('/deliverables');
  });

  it('yields contact/address when the FK is on the inherited base table', () => {
    const contactsData: DatasourceData = {
      types: [
        { contacts_base: { fields: [] } },
        { contact: { inherits: 'contacts_base', fields: [] } },
        {
          addresses_base: {
            fields: [field('contact_id', { references: 'contacts_base.id' })],
          },
        },
        { address: { inherits: 'addresses_base', fields: [] } },
      ],
    };
    const [desc] = [
      ...iterateCombinedRoutes({
        routesData: {
          combined_routes: [
            {
              contact: {
                route: '/api/contacts/{id}',
                combines: [{ address: { route: '/addresses' } }],
              },
            },
          ],
        },
        datasourceData: contactsData,
      }),
    ] as DirectFkDescriptor[];
    expect(desc.kind).toBe('direct-fk');
    expect(desc.fkColumn).toBe('contact_id');
    expect(desc.collectionPath).toBe('/api/contacts/:contactId/addresses');
  });

  it('honors an explicit route on a direct-fk child and a null child def', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ project: { route: '/deliverables' } }, { project: null } as never],
          },
        },
      ],
    };
    const descs = collect(routesData) as DirectFkDescriptor[];
    expect(descs[0].segment).toBe('/deliverables');
    expect(descs[0].collectionPath).toBe('/organizations/:organizationId/deliverables');
    expect(descs[1].segment).toBe('/projects');
  });

  it('rewrites non-id parent placeholders verbatim and id to the parent param', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/tenants/{tenant_id}/organizations/{id}',
            combined_types: ['project'],
          },
        },
      ],
    };
    const [desc] = collect(routesData);
    expect(desc.parentBasePath).toBe('/tenants/:tenant_id/organizations/:organizationId');
  });

  it('auto-detects a junction for a string child with no direct fk (default segment)', () => {
    const routesData: RoutesData = {
      combined_routes: [
        { organization: { route: '/organizations/{id}', combined_types: ['tag'] } },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expectOrgTagM2m(desc);
    expect(desc.targetParam).toBe('tagId');
    expect(desc.segment).toBe('/tags');
    expect(desc.segmentTail).toBe('tags');
    expect(desc.memberPath).toBe('/organizations/:organizationId/tags/:tagId');
  });

  it('honors an explicit route on an auto-detected junction child', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ tag: { route: '/labels' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expect(desc.segment).toBe('/labels');
    expect(desc.memberPath).toBe('/organizations/:organizationId/labels/:tagId');
  });

  it('yields an explicit m2m descriptor from via/target with a default segment', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ things: { via: 'org_tag', target: 'tag' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expectOrgTagM2m(desc);
    expect(desc.segment).toBe('/tags');
    expect(desc.collectionPath).toBe('/organizations/:organizationId/tags');
  });

  it('honors an explicit route on a via/target m2m child', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ things: { via: 'org_tag', target: 'tag', route: '/tagged' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expect(desc.segment).toBe('/tagged');
    expect(desc.memberPath).toBe('/organizations/:organizationId/tagged/:tagId');
  });

  it('defaults the parent route to empty and tolerates a missing combined_types list', () => {
    const routesData: RoutesData = { combined_routes: [{ tag: {} }] };
    expect(collect(routesData)).toEqual([]);
  });

  it('yields nothing when combined_routes is absent', () => {
    expect(collect({})).toEqual([]);
  });

  it('tolerates a datasource with no types list', () => {
    expect([...iterateCombinedRoutes({ routesData: {}, datasourceData: {} })]).toEqual([]);
  });

  it('collapses an empty-string route to an empty segment tail on a direct-fk child', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ project: { route: '' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as DirectFkDescriptor[];
    expect(desc.segment).toBe('');
    expect(desc.segmentTail).toBe('');
  });

  it('collapses an empty-string route to an empty segment tail on an auto-detected junction child', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: { route: '/organizations/{id}', combined_types: [{ tag: { route: '' } }] },
        },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expect(desc.segment).toBe('');
    expect(desc.segmentTail).toBe('');
  });

  it('collapses an empty-string route to an empty segment tail on a via/target m2m child', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/organizations/{id}',
            combined_types: [{ things: { via: 'org_tag', target: 'tag', route: '' } }],
          },
        },
      ],
    };
    const [desc] = collect(routesData) as M2mDescriptor[];
    expect(desc.segment).toBe('');
    expect(desc.segmentTail).toBe('');
  });
});

describe('iterateCombinedRoutes error branches', () => {
  it('throws when a via/target child omits target', () => {
    const routesData: RoutesData = {
      combined_routes: [
        { organization: { route: '/o', combined_types: [{ things: { via: 'org_tag' } }] } },
      ],
    };
    expect(() => collect(routesData)).toThrow(/must declare both/);
  });

  it('throws when a via/target child omits via', () => {
    const routesData: RoutesData = {
      combined_routes: [
        { organization: { route: '/o', combined_types: [{ things: { target: 'tag' } }] } },
      ],
    };
    expect(() => collect(routesData)).toThrow(/must declare both/);
  });

  it('throws when the declared junction is not in the datasource', () => {
    const routesData: RoutesData = {
      combined_routes: [
        {
          organization: {
            route: '/o',
            combined_types: [{ things: { via: 'nope', target: 'tag' } }],
          },
        },
      ],
    };
    expect(() => collect(routesData)).toThrow(/junction "nope" not found/);
  });

  it('throws when a direct child is not in the datasource', () => {
    const routesData: RoutesData = {
      combined_routes: [{ organization: { route: '/o', combined_types: ['ghost'] } }],
    };
    expect(() => collect(routesData)).toThrow(/child "ghost" not found/);
  });

  it('throws when a child has no fk and no junction', () => {
    const routesData: RoutesData = {
      combined_routes: [{ organization: { route: '/o', combined_types: ['widget'] } }],
    };
    expect(() => collect(routesData)).toThrow(/no FK to parent/);
  });

  it('throws when the junction between parent and child is ambiguous', () => {
    const routesData: RoutesData = {
      combined_routes: [{ organization: { route: '/o', combined_types: ['member'] } }],
    };
    expect(() => collect(routesData)).toThrow(/ambiguous junction/);
  });
});

describe('re-exported snakeToCamel', () => {
  it('camel-cases a snake identifier', () => {
    expect(snakeToCamel('notification_type')).toBe('notificationType');
  });
});
