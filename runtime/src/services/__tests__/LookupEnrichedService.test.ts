import { IEntityService } from '../interfaces/IEntityService';
import { LookupEnrichedService, LookupMapping } from '../LookupEnrichedService';
import { BusinessError } from '../../errors/BusinessError';
import { createMockCrudService as createMockService } from './mockCrudService';

interface TestEntity {
  id: number;
  uuid: string;
  fk_type_id: number;
  name: string;
  created: string;
  updated: string;
  type_name?: string;
}

interface TestLookup {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

interface MultiFK {
  id: number;
  uuid: string;
  alpha_type_id: number | null;
  beta_visibility_id: number | null;
  created: string;
  updated: string;
  type_name?: string;
  visibility_name?: string;
}

const TS = '2026-01-01T00:00:00Z';

function makeLookup(id: number, name: string): TestLookup {
  return { id, uuid: `l${id}`, name, created: TS, updated: TS };
}

describe('LookupEnrichedService', () => {
  let baseService: jest.Mocked<IEntityService<TestEntity>>;
  let lookupService: jest.Mocked<IEntityService<TestLookup>>;
  let mappings: LookupMapping[];
  let enrichedService: LookupEnrichedService<TestEntity>;

  beforeEach(() => {
    baseService = createMockService<TestEntity>('integer');
    lookupService = createMockService<TestLookup>('integer');
    mappings = [
      {
        fkField: 'fk_type_id',
        nameField: 'type_name',
        lookupService,
      },
    ];
    enrichedService = new LookupEnrichedService(baseService, mappings);
  });

  describe('findAll', () => {
    it('should enrich items with resolved lookup names', async () => {
      baseService.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 10, name: 'A', created: TS, updated: TS },
        { id: 2, uuid: 't2', fk_type_id: 20, name: 'B', created: TS, updated: TS },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget'), makeLookup(20, 'Gadget')]);

      const result = await enrichedService.findAll();

      expect(result).toEqual([
        {
          id: 1,
          uuid: 't1',
          fk_type_id: 10,
          name: 'A',
          type_name: 'Widget',
          created: TS,
          updated: TS,
        },
        {
          id: 2,
          uuid: 't2',
          fk_type_id: 20,
          name: 'B',
          type_name: 'Gadget',
          created: TS,
          updated: TS,
        },
      ]);
    });

    it('should return empty array when base returns empty', async () => {
      baseService.findAll.mockResolvedValue([]);

      const result = await enrichedService.findAll();

      expect(result).toEqual([]);
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });

    it('should set name to undefined when FK ID is not found in lookup', async () => {
      baseService.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 999, name: 'A', created: TS, updated: TS },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await enrichedService.findAll();

      expect(result[0].type_name).toBeUndefined();
    });
  });

  describe('findById', () => {
    it('should enrich a single item with resolved lookup name', async () => {
      baseService.findById.mockResolvedValue({
        id: 1,
        uuid: 't1',
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await enrichedService.findById(1);

      expect(result).toEqual({
        id: 1,
        uuid: 't1',
        fk_type_id: 10,
        name: 'A',
        type_name: 'Widget',
        created: TS,
        updated: TS,
      });
    });

    it('should return null when base returns null', async () => {
      baseService.findById.mockResolvedValue(null);

      const result = await enrichedService.findById(999);

      expect(result).toBeNull();
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should delegate to base and enrich the result', async () => {
      const input = { fk_type_id: 10, name: 'A' } as Omit<
        TestEntity,
        'id' | 'uuid' | 'created' | 'updated'
      >;
      baseService.create.mockResolvedValue({
        id: 1,
        uuid: 't1',
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await enrichedService.create(input);

      expect(baseService.create).toHaveBeenCalledWith(input);
      expect(result).toEqual({
        id: 1,
        uuid: 't1',
        fk_type_id: 10,
        name: 'A',
        type_name: 'Widget',
        created: TS,
        updated: TS,
      });
    });
  });

  describe('update', () => {
    it('should delegate to base and enrich the result', async () => {
      baseService.update.mockResolvedValue({
        id: 1,
        uuid: 't1',
        fk_type_id: 20,
        name: 'Updated',
        created: TS,
        updated: TS,
      });
      lookupService.findAll.mockResolvedValue([makeLookup(20, 'Gadget')]);

      const result = await enrichedService.update(1, { name: 'Updated' });

      expect(baseService.update).toHaveBeenCalledWith(1, {
        name: 'Updated',
      });
      expect(result).toEqual({
        id: 1,
        uuid: 't1',
        fk_type_id: 20,
        name: 'Updated',
        type_name: 'Gadget',
        created: TS,
        updated: TS,
      });
    });

    it('should return null when base returns null', async () => {
      baseService.update.mockResolvedValue(null);

      const result = await enrichedService.update(999, { name: 'X' });

      expect(result).toBeNull();
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delegate directly to base without enrichment', async () => {
      baseService.delete.mockResolvedValue(true);

      const result = await enrichedService.delete(1);

      expect(baseService.delete).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });

    it('should return false when base returns false', async () => {
      baseService.delete.mockResolvedValue(false);

      const result = await enrichedService.delete(999);

      expect(result).toBe(false);
    });
  });

  describe('multiple mappings', () => {
    let alphaLookup: jest.Mocked<IEntityService<TestLookup>>;
    let betaLookup: jest.Mocked<IEntityService<TestLookup>>;
    let multiService: LookupEnrichedService<MultiFK>;
    let multiBase: jest.Mocked<IEntityService<MultiFK>>;

    beforeEach(() => {
      multiBase = createMockService<MultiFK>('integer');
      alphaLookup = createMockService<TestLookup>('integer');
      betaLookup = createMockService<TestLookup>('integer');
      multiService = new LookupEnrichedService(multiBase, [
        {
          fkField: 'alpha_type_id',
          nameField: 'type_name',
          lookupService: alphaLookup,
        },
        {
          fkField: 'beta_visibility_id',
          nameField: 'visibility_name',
          lookupService: betaLookup,
        },
      ]);
    });

    it('should resolve multiple FK columns in a single entity', async () => {
      multiBase.findAll.mockResolvedValue([
        {
          id: 1,
          alpha_type_id: 10,
          beta_visibility_id: 20,
          created: TS,
          updated: TS,
        },
      ]);
      alphaLookup.findAll.mockResolvedValue([makeLookup(10, 'TypeA')]);
      betaLookup.findAll.mockResolvedValue([makeLookup(20, 'Public')]);

      const result = await multiService.findAll();

      expect(result[0].type_name).toBe('TypeA');
      expect(result[0].visibility_name).toBe('Public');
    });

    it('should handle null FK values gracefully', async () => {
      multiBase.findAll.mockResolvedValue([
        {
          id: 1,
          alpha_type_id: null,
          beta_visibility_id: null,
          created: TS,
          updated: TS,
        },
      ]);
      alphaLookup.findAll.mockResolvedValue([makeLookup(10, 'TypeA')]);
      betaLookup.findAll.mockResolvedValue([makeLookup(20, 'Public')]);

      const result = await multiService.findAll();

      expect(result[0].type_name).toBeNull();
      expect(result[0].visibility_name).toBeNull();
    });
  });

  describe('suffixField — inbound resolution (name → ID)', () => {
    let baseWithSuffix: jest.Mocked<IEntityService<TestEntity>>;
    let suffixLookup: jest.Mocked<IEntityService<TestLookup>>;
    let suffixService: LookupEnrichedService<TestEntity>;

    beforeEach(() => {
      baseWithSuffix = createMockService<TestEntity>('integer');
      suffixLookup = createMockService<TestLookup>('integer');
      suffixService = new LookupEnrichedService(baseWithSuffix, [
        {
          fkField: 'fk_type_id',
          nameField: 'type_name',
          suffixField: 'type',
          lookupService: suffixLookup,
        },
      ]);
    });

    it('create() should resolve suffixField name to fkField ID', async () => {
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget'), makeLookup(20, 'Gadget')]);
      baseWithSuffix.create.mockResolvedValue({
        id: 1,
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });

      const input = { type: 'Widget', name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >;
      await suffixService.create(input);

      // The base service should receive the resolved FK ID, not the suffix name
      expect(baseWithSuffix.create).toHaveBeenCalledWith(
        expect.objectContaining({ fk_type_id: 10, name: 'A' }),
      );
      // The suffix field should be stripped from what's passed to base
      const createArg = baseWithSuffix.create.mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).not.toHaveProperty('type');
    });

    it('create() should throw BusinessError(400) when name not found', async () => {
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const input = { type: 'NonExistent', name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >;

      await expect(suffixService.create(input)).rejects.toThrow(BusinessError);
      await expect(suffixService.create(input)).rejects.toThrow(/Invalid type: 'NonExistent'/);
    });

    it('update() should resolve suffixField name to fkField ID', async () => {
      suffixLookup.findAll.mockResolvedValue([makeLookup(20, 'Gadget')]);
      baseWithSuffix.update.mockResolvedValue({
        id: 1,
        fk_type_id: 20,
        name: 'Updated',
        created: TS,
        updated: TS,
      });

      const input = { type: 'Gadget' } as unknown as Partial<
        Omit<TestEntity, 'id' | 'created' | 'updated'>
      >;
      await suffixService.update(1, input);

      expect(baseWithSuffix.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ fk_type_id: 20 }),
      );
      const updateArg = baseWithSuffix.update.mock.calls[0][1] as Record<string, unknown>;
      expect(updateArg).not.toHaveProperty('type');
    });

    it('null suffixField should set FK to null', async () => {
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      baseWithSuffix.create.mockResolvedValue({
        id: 1,
        fk_type_id: 0,
        name: 'A',
        created: TS,
        updated: TS,
      });

      const input = { type: null, name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >;
      await suffixService.create(input);

      expect(baseWithSuffix.create).toHaveBeenCalledWith(
        expect.objectContaining({ fk_type_id: null }),
      );
    });

    it('missing suffixField should skip resolution', async () => {
      baseWithSuffix.create.mockResolvedValue({
        id: 1,
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const input = { fk_type_id: 10, name: 'A' } as Omit<TestEntity, 'id' | 'created' | 'updated'>;
      await suffixService.create(input);

      // Should pass through as-is since no suffixField present
      expect(baseWithSuffix.create).toHaveBeenCalledWith(
        expect.objectContaining({ fk_type_id: 10, name: 'A' }),
      );
    });

    it('responses should include suffixField but NOT nameField', async () => {
      baseWithSuffix.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 10, name: 'A', created: TS, updated: TS },
      ]);
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await suffixService.findAll();

      expect(result[0]).toEqual(
        expect.objectContaining({
          type: 'Widget',
        }),
      );
      // nameField should NOT be set when suffixField is present
      expect((result[0] as unknown as Record<string, unknown>).type_name).toBeUndefined();
    });

    it('responses should set suffixField to null for null FK (not nameField)', async () => {
      baseWithSuffix.findAll.mockResolvedValue([
        {
          id: 1,
          uuid: 't1',
          fk_type_id: null as unknown as number,
          name: 'A',
          created: TS,
          updated: TS,
        },
      ]);
      suffixLookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await suffixService.findAll();

      expect((result[0] as unknown as Record<string, unknown>).type).toBeNull();
      expect((result[0] as unknown as Record<string, unknown>).type_name).toBeUndefined();
    });
  });

  describe('backward compatibility — mappings without suffixField', () => {
    it('should still work when suffixField is not set', async () => {
      // Uses the default setup from the outer beforeEach (no suffixField)
      baseService.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 10, name: 'A', created: TS, updated: TS },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await enrichedService.findAll();

      expect(result[0].type_name).toBe('Widget');
      // No suffixField set, so no "type" property should appear
      expect(result[0]).not.toHaveProperty('type');
    });

    it('create should not attempt inbound resolution without suffixField', async () => {
      const input = { fk_type_id: 10, name: 'A' } as Omit<TestEntity, 'id' | 'created' | 'updated'>;
      baseService.create.mockResolvedValue({
        id: 1,
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      await enrichedService.create(input);

      expect(baseService.create).toHaveBeenCalledWith(input);
    });
  });

  describe('enrichment with undefined foreign-key values', () => {
    it('sets suffixField to undefined when the FK column is undefined', async () => {
      const base = createMockService<TestEntity>('integer');
      const lookup = createMockService<TestLookup>('integer');
      const service = new LookupEnrichedService<TestEntity>(base, [
        {
          fkField: 'fk_type_id',
          nameField: 'type_name',
          suffixField: 'type',
          lookupService: lookup,
        },
      ]);
      base.findAll.mockResolvedValue([
        {
          id: 1,
          fk_type_id: undefined as unknown as number,
          name: 'A',
          created: TS,
          updated: TS,
        },
      ]);
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      const result = await service.findAll();
      const row = result[0] as unknown as Record<string, unknown>;
      expect(row.type).toBeUndefined();
    });

    it('sets nameField to undefined when the FK column is undefined', async () => {
      baseService.findAll.mockResolvedValue([
        {
          id: 1,
          fk_type_id: undefined as unknown as number,
          name: 'A',
          created: TS,
          updated: TS,
        },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      const result = await enrichedService.findAll();
      const row = result[0] as unknown as Record<string, unknown>;
      expect(row.type_name).toBeUndefined();
    });

    it('sets nameField to null when the FK column is null (no suffixField)', async () => {
      baseService.findAll.mockResolvedValue([
        {
          id: 1,
          fk_type_id: null as unknown as number,
          name: 'A',
          created: TS,
          updated: TS,
        },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      const result = await enrichedService.findAll();
      const row = result[0] as unknown as Record<string, unknown>;
      expect(row.type_name).toBeNull();
    });
  });

  describe('findBy', () => {
    it('returns an empty array untouched without calling lookup service', async () => {
      baseService.findBy.mockResolvedValue([]);
      const result = await enrichedService.findBy([{ name: 'fk_type_id', value: '1' }]);
      expect(result).toEqual([]);
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });

    it('enriches each matching entity with lookup names', async () => {
      baseService.findBy.mockResolvedValue([
        {
          id: 1,
          fk_type_id: 10,
          name: 'A',
          created: TS,
          updated: TS,
        },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await enrichedService.findBy([{ name: 'fk_type_id', value: '10' }]);

      expect(result[0].type_name).toBe('Widget');
    });
  });

  describe('findBy with multiple values (IN-style)', () => {
    it('returns an empty array untouched without calling lookup service', async () => {
      baseService.findBy.mockResolvedValue([]);
      const result = await enrichedService.findBy([
        { name: 'fk_type_id', value: '1' },
        { name: 'fk_type_id', value: '2' },
      ]);
      expect(result).toEqual([]);
      expect(lookupService.findAll).not.toHaveBeenCalled();
    });

    it('enriches each matching entity with lookup names', async () => {
      baseService.findBy.mockResolvedValue([
        {
          id: 1,
          fk_type_id: 10,
          name: 'A',
          created: TS,
          updated: TS,
        },
        {
          id: 2,
          fk_type_id: 20,
          name: 'B',
          created: TS,
          updated: TS,
        },
      ]);
      lookupService.findAll.mockResolvedValue([makeLookup(10, 'Widget'), makeLookup(20, 'Gadget')]);

      const result = await enrichedService.findBy([
        { name: 'fk_type_id', value: '10' },
        { name: 'fk_type_id', value: '20' },
      ]);

      expect(result[0].type_name).toBe('Widget');
      expect(result[1].type_name).toBe('Gadget');
    });
  });

  describe('replaceFk: true (auto_enrich)', () => {
    let base: jest.Mocked<IEntityService<TestEntity>>;
    let lookup: jest.Mocked<IEntityService<TestLookup>>;
    let svc: LookupEnrichedService<TestEntity>;

    beforeEach(() => {
      base = createMockService<TestEntity>('integer');
      lookup = createMockService<TestLookup>('integer');
      svc = new LookupEnrichedService(base, [
        {
          fkField: 'fk_type_id',
          nameField: 'type_name',
          replaceFk: true,
          lookupService: lookup,
        },
      ]);
    });

    it('findAll: writes nameField and strips fkField from output', async () => {
      base.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 10, name: 'A', created: TS, updated: TS },
      ]);
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await svc.findAll();

      expect(result[0]).toEqual({
        id: 1,
        uuid: 't1',
        name: 'A',
        type_name: 'Widget',
        created: TS,
        updated: TS,
      });
      expect((result[0] as unknown as Record<string, unknown>).fk_type_id).toBeUndefined();
    });

    it('findById: resolves a TEXT-affinity FK stored as "1.0"', async () => {
      base.findById.mockResolvedValue({
        id: 1,
        uuid: 't1',
        fk_type_id: '1.0' as unknown as number,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookup.findAll.mockResolvedValue([makeLookup(1, 'Manual')]);

      const result = await svc.findById(1);

      expect(result?.type_name).toBe('Manual');
      expect((result as unknown as Record<string, unknown>).fk_type_id).toBeUndefined();
    });

    it('findById: strips fkField on single read', async () => {
      base.findById.mockResolvedValue({
        id: 1,
        uuid: 't1',
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await svc.findById(1);

      expect((result as unknown as Record<string, unknown>).fk_type_id).toBeUndefined();
      expect(result?.type_name).toBe('Widget');
    });

    it('add: accepts nameField, resolves to fkField, base sees fkField only', async () => {
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      base.create.mockResolvedValue({
        id: 1,
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });

      const input = { type_name: 'Widget', name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >;
      const result = await svc.create(input);

      const callArg = base.create.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.fk_type_id).toBe(10);
      expect(callArg).not.toHaveProperty('type_name');
      expect((result as unknown as Record<string, unknown>).fk_type_id).toBeUndefined();
      expect(result.type_name).toBe('Widget');
    });

    it('add: throws BusinessError(400) when nameField does not resolve', async () => {
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const input = { type_name: 'Bogus', name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >;
      await expect(svc.create(input)).rejects.toThrow(BusinessError);
      await expect(svc.create(input)).rejects.toThrow(/Invalid type_name: 'Bogus'/);
    });

    it('update: accepts nameField, resolves to fkField, base sees fkField only', async () => {
      lookup.findAll.mockResolvedValue([makeLookup(20, 'Gadget')]);
      base.update.mockResolvedValue({
        id: 1,
        fk_type_id: 20,
        name: 'B',
        created: TS,
        updated: TS,
      });

      await svc.update(1, { type_name: 'Gadget' } as unknown as Partial<
        Omit<TestEntity, 'id' | 'created' | 'updated'>
      >);

      const callArg = base.update.mock.calls[0][1] as Record<string, unknown>;
      expect(callArg.fk_type_id).toBe(20);
      expect(callArg).not.toHaveProperty('type_name');
    });

    it('null nameField sets fkField to null', async () => {
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);
      base.create.mockResolvedValue({
        id: 1,
        fk_type_id: null as unknown as number,
        name: 'A',
        created: TS,
        updated: TS,
      });

      await svc.create({ type_name: null, name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >);

      const callArg = base.create.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.fk_type_id).toBeNull();
      expect(callArg).not.toHaveProperty('type_name');
    });
  });

  describe('replaceFk: false (default — auto_enrich off)', () => {
    const makeSvc = () => {
      const base = createMockService<TestEntity>('integer');
      const lookup = createMockService<TestLookup>('integer');
      const svc = new LookupEnrichedService<TestEntity>(base, [
        { fkField: 'fk_type_id', nameField: 'type_name', lookupService: lookup },
      ]);
      return { base, lookup, svc };
    };

    it('keeps fkField alongside nameField on output', async () => {
      const { base, lookup, svc } = makeSvc();

      base.findAll.mockResolvedValue([
        { id: 1, uuid: 't1', fk_type_id: 10, name: 'A', created: TS, updated: TS },
      ]);
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      const result = await svc.findAll();

      expect(result[0].fk_type_id).toBe(10);
      expect(result[0].type_name).toBe('Widget');
    });

    it('does not accept nameField on inbound writes', async () => {
      const { base, lookup, svc } = makeSvc();

      base.create.mockResolvedValue({
        id: 1,
        fk_type_id: 10,
        name: 'A',
        created: TS,
        updated: TS,
      });
      lookup.findAll.mockResolvedValue([makeLookup(10, 'Widget')]);

      await svc.create({ type_name: 'Widget', name: 'A' } as unknown as Omit<
        TestEntity,
        'id' | 'created' | 'updated'
      >);

      // type_name passed through unchanged; base sees it (but no fk_type_id resolution happens)
      const callArg = base.create.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.type_name).toBe('Widget');
      expect(callArg.fk_type_id).toBeUndefined();
    });
  });
});
