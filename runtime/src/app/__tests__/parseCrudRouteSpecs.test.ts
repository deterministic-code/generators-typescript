import { describe, expect, it } from 'vitest';
import {
  buildBodySchema,
  parseCrudRouteSpecs,
  serviceKeyFor,
  type CrudRouteSpec,
} from '../loaders/parseCrudRouteSpecs';

const parseSpecs = (datasourceDoc: unknown, routesDoc: unknown, viewTypesDoc?: unknown) =>
  parseCrudRouteSpecs(datasourceDoc, routesDoc, { viewTypesDoc });

describe('serviceKeyFor', () => {
  it('camel-cases snake-case names and appends Service', () => {
    expect(serviceKeyFor('user')).toBe('userService');
    expect(serviceKeyFor('identity_provider_setting')).toBe('identityProviderSettingService');
  });
});

describe('buildBodySchema', () => {
  it('emits boolean, number-id, number, and string columns correctly', () => {
    const schema = buildBodySchema({
      pathSegment: 'items',
      entityName: 'item',
      primaryKeyColumn: 'id',
      primaryKeyIdType: 'integer',
      columns: ['name', 'active', 'count', 'owner_id'],
      columnTypes: { name: 'string', active: 'boolean', count: 'number', owner_id: 'number' },
    });
    const result = schema.parse({
      name: 'x',
      active: true,
      count: 3,
      owner_id: 7,
    });
    expect(result).toEqual({ name: 'x', active: true, count: 3, owner_id: 7 });
  });

  it('rejects unknown columns (strict)', () => {
    const schema = buildBodySchema({
      pathSegment: 'items',
      entityName: 'item',
      primaryKeyColumn: 'id',
      primaryKeyIdType: 'integer',
      columns: ['name'],
    });
    expect(() => schema.parse({ name: 'x', extra: 1 })).toThrow();
  });

  // LookupEnrichedService.resolveInboundNames maps `<prefix>_name`→`<prefix>_id` before the repo, so an FK with a matching enrichment column must be optional at the HTTP boundary (else a valid name-only body 400s).
  describe('enricher-resolvable FK columns are optional', () => {
    const contactSpec: CrudRouteSpec = {
      pathSegment: 'contacts',
      entityName: 'contact',
      primaryKeyColumn: 'id',
      primaryKeyIdType: 'integer',
      columns: ['first_name', 'last_name', 'email', 'contact_source_id'],
      enrichmentColumns: ['contact_source_name'],
      fields: [
        { name: 'first_name', type: 'string', size: 128 },
        { name: 'last_name', type: 'string', size: 128 },
        { name: 'email', type: 'string', size: 256, is_nullable: true },
        { name: 'contact_source_id', type: 'number', references: 'contact_source.id' },
      ],
    };

    it('accepts the enrichment name without the FK id', () => {
      const schema = buildBodySchema(contactSpec);
      expect(() =>
        schema.parse({
          first_name: 'Ada',
          last_name: 'Lovelace',
          contact_source_name: 'Manual',
        }),
      ).not.toThrow();
    });

    it('still accepts the FK id directly (backwards-compatible)', () => {
      const schema = buildBodySchema(contactSpec);
      const result = schema.parse({
        first_name: 'Ada',
        last_name: 'Lovelace',
        contact_source_id: 1,
      });
      expect(result.contact_source_id).toBe(1);
    });

    it('keeps FK required when no matching <prefix>_name is in enrichmentColumns', () => {
      const schema = buildBodySchema({
        pathSegment: 'contacts',
        entityName: 'contact',
        primaryKeyColumn: 'id',
        primaryKeyIdType: 'integer',
        columns: ['first_name', 'last_name', 'contact_source_id'],
        fields: [
          { name: 'first_name', type: 'string', size: 128 },
          { name: 'last_name', type: 'string', size: 128 },
          { name: 'contact_source_id', type: 'number', references: 'contact_source.id' },
        ],
      });
      expect(() =>
        schema.parse({
          first_name: 'Ada',
          last_name: 'Lovelace',
        }),
      ).toThrow(/contact_source_id/);
    });
  });
});

describe('parseCrudRouteSpecs', () => {
  it('derives plural kebab path segments and column metadata', () => {
    const specs = parseSpecs(
      {
        types: [
          {
            user: {
              fields: [
                { name: { type: 'string' } },
                { active: { type: 'boolean' } },
                { age: { type: 'number' } },
              ],
            },
          },
        ],
      },
      { combined_routes: [] },
    );
    expect(specs).toEqual([
      {
        pathSegment: 'users',
        entityName: 'user',
        primaryKeyColumn: 'id',
        primaryKeyIdType: 'integer',
        primaryKeyColumns: [{ column: 'id', idType: 'integer' }],
        columns: ['name', 'active', 'age'],
        columnTypes: { name: 'string', active: 'boolean', age: 'number' },
        fields: [
          { name: 'name', type: 'string' },
          { name: 'active', type: 'boolean' },
          { name: 'age', type: 'number' },
        ],
      },
    ]);
  });

  it('reads type-level ids as a composite identity', () => {
    const specs = parseSpecs(
      {
        types: [
          {
            link: {
              ids: ['left_id', 'right_id'],
              fields: [
                { left_id: { type: 'integer' } },
                { right_id: { type: 'integer' } },
              ],
            },
          },
        ],
      },
      { combined_routes: [] },
    );
    expect(specs[0].primaryKeyColumn).toBe('left_id');
    expect(specs[0].primaryKeyIdType).toBe('integer');
    expect(specs[0].primaryKeyColumns).toEqual([
      { column: 'left_id', idType: 'integer' },
      { column: 'right_id', idType: 'integer' },
    ]);
  });

  it('flattens inherits and union mappings onto a view type (contact pattern)', () => {
    const specs = parseCrudRouteSpecs(
      {
        types: [
          {
            base: {
              fields: [
                { id: { type: 'integer', is_id: true } },
                { uuid: { type: 'uuid' } },
                { created: { type: 'datetime' } },
                { updated: { type: 'datetime' } },
                { version: { type: 'binary', default_value: '' } },
              ],
            },
          },
          {
            contacts_base: {
              inherits: 'base',
              fields: [
                { contact_source_id: { type: 'number', references: 'contact_source.id' } },
                { first_name: { type: 'string', size: 128 } },
                { last_name: { type: 'string', size: 128 } },
              ],
            },
          },
          {
            contact_source: {
              tags: ['datasource_type', 'view_type', 'readonly_lookup'],
              inherits: 'base',
              fields: [{ name: { type: 'string' } }],
            },
          },
          {
            contact: {
              tags: ['view_type'],
              inherits: 'contacts_base',
              union: ['contact_source'],
              mapping: { name: 'contact_source_name' },
              remove_fields: [
                'contact_source.id',
                'contact_source.uuid',
                'contact_source.created',
                'contact_source.updated',
                'contact_source.version',
              ],
              fields: [{ addresses: { type: 'address[]', references: 'addresses_base.contact_id' } }],
            },
          },
        ],
      },
      { combined_routes: [] },
      {
        overlaysDoc: {
          types: [{ contact_source: { fields: [{ name: { is_unique: true } }] } }],
        },
      },
    );
    const contact = specs.find((s) => s.entityName === 'contact');
    expect(contact?.columns).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'contact_source_id', 'contact_source_name']),
    );
    expect(contact?.columns).not.toContain('addresses');
    expect(contact?.enrichmentColumns).toEqual(['contact_source_name']);
    expect(contact?.replaceLookupFks).toBe(true);
    expect(contact?.fields?.find((f) => f.name === 'contact_source_id')?.references).toBe(
      'contact_source.id',
    );
    expect(contact?.columnTypes?.contact_source_id).toBe('number');
    const parsed = buildBodySchema(contact!, 'create').parse({
      first_name: 'Ada',
      last_name: 'Lovelace',
      contact_source_name: 'Manual',
    });
    expect(parsed.first_name).toBe('Ada');
    expect(parsed.contact_source_name).toBe('Manual');
  });

  it('infers integer columnTypes for a references-only FK (contacts_base.contact_source_id)', () => {
    const specs = parseSpecs(
      {
        types: [
          {
            contacts_base: {
              fields: [
                { contact_source_id: { references: 'contact_source.id' } },
                { first_name: { type: 'string' } },
              ],
            },
          },
        ],
      },
      { combined_routes: [] },
    );
    expect(specs[0]?.columnTypes?.contact_source_id).toBe('integer');
    expect(specs[0]?.fields?.find((f) => f.name === 'contact_source_id')).toEqual({
      name: 'contact_source_id',
      type: 'integer',
      references: 'contact_source.id',
    });
  });

  it('uses datasource overlay is_fixed_id as the primary key (legacy_contact.key)', () => {
    const specs = parseCrudRouteSpecs(
      {
        types: [
          {
            legacy_contact: {
              fields: [
                { key: { type: 'string', size: 64 } },
                { first_name: { type: 'string' } },
              ],
            },
          },
        ],
      },
      { combined_routes: [] },
      {
        overlaysDoc: {
          types: [
            {
              legacy_contact: {
                fields: [{ key: { is_fixed_id: true, is_unique: true } }],
              },
            },
          ],
        },
      },
    );
    expect(specs[0].primaryKeyColumn).toBe('key');
    expect(specs[0].primaryKeyIdType).toBe('string');
    expect(specs[0].primaryKeyColumns).toEqual([{ column: 'key', idType: 'string' }]);
  });

  it('flags readonly-lookup and many-to-many datasource types', () => {
    const specs = parseSpecs(
      {
        types: [
          { country: { datasource_type: 'readonly-lookup', fields: [] } },
          { user_role: { datasource_type: 'many-to-many', fields: [] } },
        ],
      },
      { combined_routes: [] },
    );
    expect(specs[0].readonly).toBe(true);
    expect(specs[1].m2m).toBe(true);
  });

  it('marks a child as nestedOnly when it has a direct FK to the combined parent', () => {
    const specs = parseSpecs(
      {
        types: [
          { project: { fields: [{ name: { type: 'string' } }] } },
          {
            project_setting: {
              fields: [{ project_id: { type: 'number', references: 'project.id' } }],
            },
          },
        ],
      },
      {
        combined_routes: [{ projects: { combined_types: ['project_settings'] } }],
      },
    );
    const setting = specs.find((s) => s.entityName === 'project_setting');
    expect(setting?.nestedOnly).toBe(true);
  });

  it('does not mark an entity nestedOnly when it is also a combined-route parent', () => {
    const specs = parseSpecs(
      {
        types: [
          { email_account: { fields: [{ name: { type: 'string' } }] } },
          {
            folder: {
              fields: [{ email_account_id: { type: 'number', references: 'email_account.id' } }],
            },
          },
          {
            message: {
              fields: [{ folder_id: { type: 'number', references: 'folder.id' } }],
            },
          },
          {
            attachment: {
              fields: [{ message_id: { type: 'number', references: 'message.id' } }],
            },
          },
        ],
      },
      {
        combined_routes: [
          { email_account: { combined_types: ['folder'] } },
          { folder: { combined_types: ['message'] } },
          { message: { combined_types: ['attachment'] } },
        ],
      },
    );
    const folder = specs.find((s) => s.entityName === 'folder');
    const message = specs.find((s) => s.entityName === 'message');
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(folder?.nestedOnly).toBeUndefined();
    expect(message?.nestedOnly).toBeUndefined();
    expect(attachment?.nestedOnly).toBe(true);
  });

  it('does not nest a child when the combined entry uses via/target', () => {
    const specs = parseSpecs(
      {
        types: [
          { project: { fields: [] } },
          {
            project_setting: {
              fields: [{ project_id: { type: 'number', references: 'project.id' } }],
            },
          },
        ],
      },
      {
        combined_routes: [
          {
            projects: {
              combined_types: [{ project_settings: { via: 'project_id', target: 'setting' } }],
            },
          },
        ],
      },
    );
    const setting = specs.find((s) => s.entityName === 'project_setting');
    expect(setting?.nestedOnly).toBeUndefined();
  });

  it('returns empty for missing types', () => {
    expect(parseSpecs({}, {})).toEqual([]);
    expect(parseSpecs(null, null)).toEqual([]);
  });

  it('pluralises sibilant-final names with -es (address -> addresses, box -> boxes)', () => {
    const specs = parseSpecs(
      {
        types: [
          { address: { fields: [{ line1: { type: 'string' } }] } },
          { box: { fields: [{ size: { type: 'number' } }] } },
          { dish: { fields: [{ name: { type: 'string' } }] } },
        ],
      },
      { combined_routes: [] },
    );
    const byName = new Map(specs.map((s) => [s.entityName, s.pathSegment]));
    expect(byName.get('address')).toBe('addresses');
    expect(byName.get('box')).toBe('boxes');
    expect(byName.get('dish')).toBe('dishes');
  });
});

describe('parseCrudRouteSpecs — byField routes', () => {
  const ATTACHMENT_DOC = {
    types: [
      {
        attachment: {
          fields: [
            { message_id: { type: 'number', references: 'message.id' } },
            { filename: { type: 'string', size: 256 } },
            { mime_type: { type: 'string', size: 128 } },
          ],
        },
      },
    ],
  };

  it('parses shorthand string with GET verb: get_attachments_by_filename', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: ['get_attachments_by_filename'],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([{ field: 'filename', unique: false, methods: ['GET'] }]);
  });

  it('parses shorthand camelCase byField into snake_case: messageId → message_id', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: ['get_attachments_by_messageId'],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([
      { field: 'message_id', unique: false, methods: ['GET'] },
    ]);
  });

  it('shorthand without verb prefix defaults to GET/PUT/DELETE', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: ['attachments_by_filename'],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([
      { field: 'filename', unique: false, methods: ['GET', 'PUT', 'DELETE'] },
    ]);
  });

  it('verbose form { name: { entity, byField, methods? } } still works (regression)', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: [
        {
          lookup_attachment_by_filename: {
            entity: 'attachment',
            byField: 'filename',
            methods: ['GET'],
          },
        },
      ],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([{ field: 'filename', unique: false, methods: ['GET'] }]);
  });

  it('mixed routes.yaml with both shorthand and verbose entries', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: [
        'get_attachments_by_filename',
        {
          lookup_by_mime: {
            entity: 'attachment',
            byField: 'mime_type',
            methods: ['GET'],
          },
        },
      ],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([
      { field: 'filename', unique: false, methods: ['GET'] },
      { field: 'mime_type', unique: false, methods: ['GET'] },
    ]);
  });

  it('empty-map shorthand { token: null } parses key as shorthand', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: [{ get_attachments_by_messageId: null }],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([
      { field: 'message_id', unique: false, methods: ['GET'] },
    ]);
  });

  it('throws on unknown entity in shorthand', () => {
    expect(() =>
      parseSpecs(ATTACHMENT_DOC, {
        routes: ['get_widgets_by_color'],
      }),
    ).toThrow(/unknown entity `widget`/);
  });

  it('throws on unknown field on a known entity', () => {
    expect(() =>
      parseSpecs(ATTACHMENT_DOC, {
        routes: ['get_attachments_by_color'],
      }),
    ).toThrow(/field `color` not found on entity `attachment`/);
  });

  it('resolves unique=true when underlying field has is_unique', () => {
    const specs = parseSpecs(
      {
        types: [
          {
            notification: {
              fields: [{ key: { type: 'string', is_unique: true } }],
            },
          },
        ],
      },
      { routes: ['get_notifications_by_key'] },
    );
    const notification = specs.find((s) => s.entityName === 'notification');
    expect(notification?.byFields).toEqual([{ field: 'key', unique: true, methods: ['GET'] }]);
  });

  it('ignores non-byField custom route entries (e.g. { health: { path, method, ... } })', () => {
    const specs = parseSpecs(ATTACHMENT_DOC, {
      routes: [
        {
          health: {
            path: '/api/health',
            method: 'GET',
            service: 'HealthCheckService',
          },
        },
        'get_attachments_by_filename',
      ],
    });
    const attachment = specs.find((s) => s.entityName === 'attachment');
    expect(attachment?.byFields).toEqual([{ field: 'filename', unique: false, methods: ['GET'] }]);
  });
});
