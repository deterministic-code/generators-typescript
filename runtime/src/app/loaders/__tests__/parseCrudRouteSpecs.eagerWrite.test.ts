import { describe, expect, it } from 'vitest';

import { buildBodySchema, parseCrudRouteSpecs } from '../parseCrudRouteSpecs';

const parseSpecs = (datasourceDoc: unknown, routesDoc: unknown, viewTypesDoc?: unknown) =>
  parseCrudRouteSpecs(datasourceDoc, routesDoc, { viewTypesDoc });

type DatasourceDoc = Parameters<typeof parseCrudRouteSpecs>[0];
type RoutesDoc = Parameters<typeof parseCrudRouteSpecs>[1];
type ViewTypesDoc = Parameters<typeof parseCrudRouteSpecs>[2]['viewTypesDoc'];

const DATASOURCE_DOC: DatasourceDoc = {
  types: [
    {
      contact: {
        fields: [{ name: { type: 'string' } }, { email: { type: 'string' } }],
      },
    },
    {
      address: {
        fields: [
          { contact_id: { type: 'number', references: 'contact.id' } },
          { line1: { type: 'string' } },
          { city: { type: 'string' } },
        ],
      },
    },
    {
      phone: {
        fields: [
          { contact_id: { type: 'number', references: 'contact.id' } },
          { number: { type: 'string' } },
        ],
      },
    },
    {
      todo: {
        fields: [{ title: { type: 'string' } }, { is_done: { type: 'boolean' } }],
      },
    },
    {
      task: {
        fields: [
          { todo_id: { type: 'number', references: 'todo.id' } },
          { description: { type: 'string' } },
        ],
      },
    },
    {
      meeting: {
        fields: [
          { todo_id: { type: 'number', references: 'todo.id' } },
          { scheduled_at: { type: 'datetime' } },
        ],
      },
    },
  ],
};

const ROUTES_DOC: RoutesDoc = {
  includes: [
    {
      view_type_routes: {
        eager_write_path: ['contact.addresses', 'contact.phones', 'todo.tasks', 'todo.meetings'],
      },
    },
  ],
};

const VIEW_TYPES_DOC: ViewTypesDoc = {
  types: [
    {
      contact: {
        inherits: 'datasource_types.contact',
        fields: [
          {
            addresses: {
              type: 'datasource_types.address[]',
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
    {
      todo: {
        inherits: 'datasource_types.todo',
        fields: [
          {
            tasks: {
              type: 'datasource_types.task[]',
              references: 'datasource_types.task.todo_id',
            },
          },
          {
            meetings: {
              type: 'datasource_types.meeting[]',
              references: 'datasource_types.meeting.todo_id',
            },
          },
        ],
      },
    },
  ],
};

const ALICE_WITH_ADDRESS = {
  name: 'Alice',
  email: 'alice@example.com',
  addresses: [{ line1: '123 Main St', city: 'Springfield' }],
};

const ALICE_WITH_ID_ADDRESS = {
  name: 'Alice',
  email: 'alice@example.com',
  addresses: [{ id: 1, line1: '123 Main St', city: 'Springfield' }],
};

const expectAccepts = (schema: ReturnType<typeof buildBodySchema>, body: unknown) =>
  expect(schema.safeParse(body).success).toBe(true);

describe('parseCrudRouteSpecs with eager-write', () => {
  const contactBodySchema = () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    return buildBodySchema(contactSpec!);
  };
  const contactVerbSchema = (verb: 'create' | 'update' | 'patch') => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    return buildBodySchema(contactSpec!, verb);
  };

  it('backward-compat: calling without viewTypesDoc returns unchanged specs', () => {
    const specs = parseSpecs(DATASOURCE_DOC, {});
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    expect(contactSpec).toBeDefined();
    expect(contactSpec?.eagerWriteChildren).toBeUndefined();
  });

  it('backward-compat: calling with viewTypesDoc but no eager_write_path returns unchanged specs', () => {
    const specs = parseSpecs(DATASOURCE_DOC, {}, VIEW_TYPES_DOC);
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    expect(contactSpec).toBeDefined();
    expect(contactSpec?.eagerWriteChildren).toBeUndefined();
  });

  it('attaches eagerWriteChildren to contact with both addresses and phones', () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const contactSpec = specs.find((s) => s.entityName === 'contact');

    expect(contactSpec).toBeDefined();
    expect(contactSpec?.eagerWriteChildren).toHaveLength(2);

    const addressChild = contactSpec?.eagerWriteChildren?.[0];
    expect(addressChild?.fieldName).toBe('addresses');
    expect(addressChild?.childTable).toBe('address');
    expect(addressChild?.fkColumn).toBe('contact_id');

    const phoneChild = contactSpec?.eagerWriteChildren?.[1];
    expect(phoneChild?.fieldName).toBe('phones');
    expect(phoneChild?.childTable).toBe('phone');
    expect(phoneChild?.fkColumn).toBe('contact_id');
  });

  it('eagerWriteChildren[0] excludes the server-supplied FK from childColumns and childColumnTypes', () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    const addressChild = contactSpec?.eagerWriteChildren?.[0];

    expect(addressChild?.childColumns).toEqual(['line1', 'city']);
    expect(addressChild?.childColumns).not.toContain('contact_id');
    expect(addressChild?.childColumnTypes).toEqual({ line1: 'string', city: 'string' });
    expect(addressChild?.childColumnTypes).not.toHaveProperty('contact_id');
  });

  it('attaches eagerWriteChildren to todo with both tasks and meetings', () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const todoSpec = specs.find((s) => s.entityName === 'todo');

    expect(todoSpec).toBeDefined();
    expect(todoSpec?.eagerWriteChildren).toHaveLength(2);

    const taskChild = todoSpec?.eagerWriteChildren?.[0];
    expect(taskChild?.fieldName).toBe('tasks');
    expect(taskChild?.childTable).toBe('task');
    expect(taskChild?.fkColumn).toBe('todo_id');

    const meetingChild = todoSpec?.eagerWriteChildren?.[1];
    expect(meetingChild?.fieldName).toBe('meetings');
    expect(meetingChild?.childTable).toBe('meeting');
    expect(meetingChild?.fkColumn).toBe('todo_id');
  });

  it('todo.tasks does not include todo_id in childColumns', () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const todoSpec = specs.find((s) => s.entityName === 'todo');
    const taskChild = todoSpec?.eagerWriteChildren?.[0];

    expect(taskChild?.childColumns).toEqual(['description']);
    expect(taskChild?.childColumns).not.toContain('todo_id');
  });

  it('buildBodySchema for contact accepts { name, email, addresses: [...] }', () => {
    expectAccepts(contactBodySchema(), ALICE_WITH_ADDRESS);
  });

  it('buildBodySchema rejects child row with _delete field', () => {
    const schema = contactBodySchema();

    const invalid = schema.safeParse({
      name: 'Alice',
      addresses: [{ id: 42, _delete: true, line1: '123 Main St', city: 'Springfield' }],
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((i) => i.message.includes('Unrecognized key(s)'))).toBe(
        true,
      );
    }
  });

  it('buildBodySchema rejects unknown keys on child rows (strict)', () => {
    const schema = contactBodySchema();

    const invalid = schema.safeParse({
      name: 'Alice',
      addresses: [{ line1: '123 Main St', city: 'Springfield', unknown_field: 'oops' }],
    });

    expect(invalid.success).toBe(false);
  });

  it('buildBodySchema rejects contact_id on child row (server-supplied)', () => {
    const schema = contactBodySchema();

    const invalid = schema.safeParse({
      name: 'Alice',
      addresses: [{ contact_id: 99, line1: '123 Main St', city: 'Springfield' }],
    });

    expect(invalid.success).toBe(false);
  });

  it('buildBodySchema accepts body without addresses key (children optional)', () => {
    const schema = contactBodySchema();

    const valid = schema.safeParse({
      name: 'Alice',
      email: 'alice@example.com',
    });

    expect(valid.success).toBe(true);
  });

  it('buildBodySchema for non-eager-write entity returns original behavior', () => {
    const specs = parseSpecs(DATASOURCE_DOC, ROUTES_DOC, VIEW_TYPES_DOC);
    const userSpec = specs.find((s) => s.entityName === 'user');

    if (userSpec) {
      expect(userSpec?.eagerWriteChildren).toBeUndefined();
      const schema = buildBodySchema(userSpec);
      const valid = schema.safeParse({ name: 'Test' });
      expect(valid.success).toBe(true);
    }
  });

  it('buildBodySchema with verb="create" rejects id on child rows', () => {
    const schema = contactVerbSchema('create');

    const invalid = schema.safeParse({
      name: 'Alice',
      addresses: [{ id: 1, line1: '123 Main St', city: 'Springfield' }],
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((i) => i.message.includes('Unrecognized key(s)'))).toBe(
        true,
      );
    }
  });

  it('buildBodySchema with verb="create" accepts child rows without id', () => {
    expectAccepts(contactVerbSchema('create'), ALICE_WITH_ADDRESS);
  });

  it('buildBodySchema with verb="update" still accepts optional id on child rows (regression)', () => {
    expectAccepts(contactVerbSchema('update'), ALICE_WITH_ID_ADDRESS);
  });

  it('buildBodySchema with verb="patch" still accepts optional id on child rows (regression)', () => {
    expectAccepts(contactVerbSchema('patch'), ALICE_WITH_ID_ADDRESS);
  });

  it('resolves a singular nested object field and accepts an object body', () => {
    const viewTypes: ViewTypesDoc = {
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
    const routes = {
      includes: [
        {
          view_type_routes: {
            eager_write_path: ['contact.address'],
          },
        },
      ],
    };
    const specs = parseSpecs(DATASOURCE_DOC, routes, viewTypes);
    const contactSpec = specs.find((s) => s.entityName === 'contact');
    expect(contactSpec?.eagerWriteChildren).toEqual([
      expect.objectContaining({
        fieldName: 'address',
        childTable: 'address',
        fkColumn: 'contact_id',
        isArray: false,
      }),
    ]);
    const schema = buildBodySchema(contactSpec!, 'create');
    expect(
      schema.safeParse({
        name: 'Alice',
        email: 'alice@example.com',
        address: { line1: '123 Main St', city: 'Springfield' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        name: 'Alice',
        email: 'alice@example.com',
        address: [{ line1: '123 Main St', city: 'Springfield' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        name: 'Alice',
        email: 'alice@example.com',
        address: null,
      }).success,
    ).toBe(true);
  });
});
