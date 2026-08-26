import { IEntityService } from '../interfaces/IEntityService';
import { EagerChildLoadingService } from '../EagerChildLoadingService';
import { EagerChildSpec } from '../../app/loaders/computeEagerChildren';
import { createMockCrudService as createMockService } from './mockCrudService';

interface Parent {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
  children?: Child[];
  tags?: Tag[];
}

interface Child {
  id: number;
  uuid: string;
  parent_id: number;
  value: string;
  created: string;
  updated: string;
}

interface Grandchild {
  id: number;
  uuid: string;
  parent_id: number;
  data: string;
  created: string;
  updated: string;
}

interface Tag {
  id: number;
  uuid: string;
  name: string;
  created: string;
  updated: string;
}

const TS = '2026-01-01T00:00:00Z';

const parentRow = (id: number) => ({
  id,
  uuid: `p${id}`,
  name: `Parent${id}`,
  created: TS,
  updated: TS,
});
const childRow = (id: number, parentId: number, value: string) => ({
  id,
  uuid: `c${id}`,
  parent_id: parentId,
  value,
  created: TS,
  updated: TS,
});
const grandchildRow = (id: number, parentId: number, data: string) => ({
  id,
  uuid: `gc${id}`,
  parent_id: parentId,
  data,
  created: TS,
  updated: TS,
});

describe('EagerChildLoadingService', () => {
  let baseService: jest.Mocked<IEntityService<Parent>>;
  let childService: jest.Mocked<IEntityService<Child>>;
  let childSpecs: EagerChildSpec[];
  let service: EagerChildLoadingService<Parent>;

  beforeEach(() => {
    baseService = createMockService<Parent>('integer');
    childService = createMockService<Child>('integer');
    childSpecs = [
      {
        fieldName: 'children',
        childTable: 'child',
        refColumn: 'parent_id',
      },
    ];
    const childServiceMap = new Map<string, IEntityService<any, any>>();
    childServiceMap.set('child', childService);
    service = new EagerChildLoadingService(baseService, childSpecs, childServiceMap);
  });

  const makeMultiService = () => {
    const grandchildService = createMockService<Grandchild>('integer');
    const multiSpecs: EagerChildSpec[] = [
      { fieldName: 'children', childTable: 'child', refColumn: 'parent_id' },
      { fieldName: 'grandchildren', childTable: 'grandchild', refColumn: 'parent_id' },
    ];
    const childServiceMap = new Map<string, IEntityService<any, any>>();
    childServiceMap.set('child', childService);
    childServiceMap.set('grandchild', grandchildService);
    const multiService = new EagerChildLoadingService(baseService, multiSpecs, childServiceMap);
    return { grandchildService, multiService };
  };

  describe('find', () => {
    it('returns null passthrough when base returns null', async () => {
      baseService.findById.mockResolvedValue(null);

      const result = await service.findById(999);

      expect(result).toBeNull();
      expect(childService.findBy).not.toHaveBeenCalled();
    });

    it('attaches each child array under its fieldName', async () => {
      baseService.findById.mockResolvedValue(parentRow(1));
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A'), childRow(11, 1, 'B')]);

      const result = await service.findById(1);

      expect(result).toEqual({
        ...parentRow(1),
        children: [childRow(10, 1, 'A'), childRow(11, 1, 'B')],
      });
      expect(childService.findBy).toHaveBeenCalledWith([{ name: 'parent_id', value: 1 }]);
    });

    it('attaches a singular nested object (or null) when isArray is false', async () => {
      const singularSpecs: EagerChildSpec[] = [
        {
          fieldName: 'child',
          childTable: 'child',
          refColumn: 'parent_id',
          isArray: false,
        },
      ];
      const map = new Map<string, IEntityService<any, any>>();
      map.set('child', childService);
      const singularService = new EagerChildLoadingService(baseService, singularSpecs, map);
      baseService.findById.mockResolvedValue(parentRow(1));
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A')]);

      const result = await singularService.findById(1);

      expect(result).toEqual({
        ...parentRow(1),
        child: childRow(10, 1, 'A'),
      });

      childService.findBy.mockResolvedValue([]);
      const empty = await singularService.findById(1);
      expect(empty).toEqual({ ...parentRow(1), child: null });
    });
  });

  describe('singular findAll / create', () => {
    const singularService = () => {
      const specs: EagerChildSpec[] = [
        {
          fieldName: 'child',
          childTable: 'child',
          refColumn: 'parent_id',
          isArray: false,
        },
      ];
      const map = new Map<string, IEntityService<any, any>>();
      map.set('child', childService);
      return new EagerChildLoadingService(baseService, specs, map);
    };

    it('packs one object per parent on a batched findAll', async () => {
      baseService.findAll.mockResolvedValue([parentRow(1), parentRow(2)]);
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A'), childRow(20, 2, 'C')]);

      const result = await singularService().findAll();

      expect(result[0]).toEqual({ ...parentRow(1), child: childRow(10, 1, 'A') });
      expect(result[1]).toEqual({ ...parentRow(2), child: childRow(20, 2, 'C') });
    });

    it('packs null on create instead of an empty array', async () => {
      baseService.create.mockResolvedValue(parentRow(1));
      const created = await singularService().create({
        name: 'Parent1',
      } as unknown as Omit<Parent, 'id' | 'uuid' | 'created' | 'updated'>);
      expect(created).toEqual({ ...parentRow(1), child: null });
    });
  });

  describe('findAll', () => {
    it('uses batched findBy for all children at once', async () => {
      baseService.findAll.mockResolvedValue([parentRow(1), parentRow(2)]);
      childService.findBy.mockResolvedValue([
        childRow(10, 1, 'A'),
        childRow(11, 1, 'B'),
        childRow(20, 2, 'C'),
      ]);

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(result[0].children).toEqual([childRow(10, 1, 'A'), childRow(11, 1, 'B')]);
      expect(result[1].children).toEqual([childRow(20, 2, 'C')]);
      expect(childService.findBy).toHaveBeenCalledOnce();
      expect(childService.findBy).toHaveBeenCalledWith([
        { name: 'parent_id', value: 1 },
        { name: 'parent_id', value: 2 },
      ]);
    });

    it('returns empty array without calling findBy', async () => {
      baseService.findAll.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual([]);
      expect(childService.findBy).not.toHaveBeenCalled();
    });

    it('assigns empty array for parents with no matching children', async () => {
      baseService.findAll.mockResolvedValue([parentRow(1), parentRow(2)]);
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A')]);

      const result = await service.findAll();

      expect(result[0].children).toEqual([childRow(10, 1, 'A')]);
      expect(result[1].children).toEqual([]);
    });
  });

  describe('memberOnly children', () => {
    const makeMemberOnlyService = () => {
      const grandchildService = createMockService<Grandchild>('integer');
      const specs: EagerChildSpec[] = [
        { fieldName: 'children', childTable: 'child', refColumn: 'parent_id' },
        {
          fieldName: 'grandchildren',
          childTable: 'grandchild',
          refColumn: 'parent_id',
          memberOnly: true,
        },
      ];
      const childServiceMap = new Map<string, IEntityService<any, any>>();
      childServiceMap.set('child', childService);
      childServiceMap.set('grandchild', grandchildService);
      return {
        grandchildService,
        memberOnlyService: new EagerChildLoadingService(baseService, specs, childServiceMap),
      };
    };

    it('skips a memberOnly child on findAll but attaches the non-member-only child', async () => {
      const { grandchildService, memberOnlyService } = makeMemberOnlyService();
      baseService.findAll.mockResolvedValue([parentRow(1)]);
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A')]);

      const result = (await memberOnlyService.findAll()) as Array<Record<string, unknown>>;

      expect(result[0]!.children).toEqual([childRow(10, 1, 'A')]);
      expect('grandchildren' in result[0]!).toBe(false);
      expect(grandchildService.findBy).not.toHaveBeenCalled();
    });

    it('attaches a memberOnly child on findById', async () => {
      const { grandchildService, memberOnlyService } = makeMemberOnlyService();
      baseService.findById.mockResolvedValue(parentRow(1));
      childService.findBy.mockResolvedValue([]);
      grandchildService.findBy.mockResolvedValue([grandchildRow(30, 1, 'X')]);

      const result = (await memberOnlyService.findById(1)) as Record<string, unknown>;

      expect(result.grandchildren).toEqual([grandchildRow(30, 1, 'X')]);
      expect(grandchildService.findBy).toHaveBeenCalledWith([{ name: 'parent_id', value: 1 }]);
    });
  });

  describe('findBy', () => {
    it('uses batched findBy for all children at once', async () => {
      baseService.findBy.mockResolvedValue([
        { id: 1, uuid: 'p1', name: 'Parent1', created: TS, updated: TS },
      ]);
      childService.findBy.mockResolvedValue([
        { id: 10, uuid: 'c10', parent_id: 1, value: 'A', created: TS, updated: TS },
      ]);

      const result = await service.findBy([{ name: 'name', value: 'Parent1' }]);

      expect(result).toEqual([
        {
          id: 1,
          uuid: 'p1',
          name: 'Parent1',
          created: TS,
          updated: TS,
          children: [{ id: 10, uuid: 'c10', parent_id: 1, value: 'A', created: TS, updated: TS }],
        },
      ]);
      expect(childService.findBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('synthesizes [] for each declared eager-load field without calling child services', async () => {
      baseService.create.mockResolvedValue({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
      });

      const input = { name: 'NewParent' } as unknown as Omit<
        Parent,
        'id' | 'uuid' | 'created' | 'updated'
      >;
      const result = await service.create(input);

      expect(result).toEqual({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
        children: [],
      });
      expect(childService.findBy).not.toHaveBeenCalled();
    });

    it('synthesizes [] for each spec when multiple child types declared', async () => {
      const { grandchildService, multiService } = makeMultiService();

      baseService.create.mockResolvedValue({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
      });

      const input = { name: 'NewParent' } as unknown as Omit<
        Parent,
        'id' | 'uuid' | 'created' | 'updated'
      >;
      const result = await multiService.create(input);

      expect(result).toEqual({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
        children: [],
        grandchildren: [],
      });
      expect(childService.findBy).not.toHaveBeenCalled();
      expect(grandchildService.findBy).not.toHaveBeenCalled();
    });

    it('omits the field when child service is missing on create', async () => {
      baseService.create.mockResolvedValue({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
      });
      const emptyMap = new Map<string, IEntityService<any, any>>();
      const serviceWithMissing = new EagerChildLoadingService(baseService, childSpecs, emptyMap);

      const input = { name: 'NewParent' } as unknown as Omit<
        Parent,
        'id' | 'uuid' | 'created' | 'updated'
      >;
      const result = await serviceWithMissing.create(input);

      expect(result).toEqual({
        id: 1,
        uuid: 'p1',
        name: 'NewParent',
        created: TS,
        updated: TS,
      });
      expect(childService.findBy).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('attaches children to the returned entity', async () => {
      baseService.update.mockResolvedValue({
        id: 1,
        name: 'UpdatedParent',
        created: TS,
        updated: TS,
      });
      childService.findBy.mockResolvedValue([
        { id: 10, parent_id: 1, value: 'A', created: TS, updated: TS },
      ]);

      const result = await service.update(1, { name: 'UpdatedParent' });

      expect(result).toEqual({
        id: 1,
        name: 'UpdatedParent',
        created: TS,
        updated: TS,
        children: [{ id: 10, parent_id: 1, value: 'A', created: TS, updated: TS }],
      });
      expect(childService.findBy).toHaveBeenCalledWith([{ name: 'parent_id', value: 1 }]);
    });

    it('returns null when base returns null', async () => {
      baseService.update.mockResolvedValue(null);

      const result = await service.update(999, { name: 'X' });

      expect(result).toBeNull();
      expect(childService.findBy).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('passes through unchanged', async () => {
      baseService.delete.mockResolvedValue(true);

      const result = await service.delete(1);

      expect(result).toBe(true);
      expect(childService.findBy).not.toHaveBeenCalled();
    });

    it('returns false when base returns false', async () => {
      baseService.delete.mockResolvedValue(false);

      const result = await service.delete(999);

      expect(result).toBe(false);
    });
  });

  describe('empty children array', () => {
    it('decorator is a no-op proxy when no children specs', async () => {
      const noChildService = new EagerChildLoadingService(baseService, [], new Map());
      baseService.findById.mockResolvedValue({
        id: 1,
        uuid: 'p1',
        name: 'Parent1',
        created: TS,
        updated: TS,
      });

      const result = await noChildService.findById(1);

      expect(result).toEqual({
        id: 1,
        uuid: 'p1',
        name: 'Parent1',
        created: TS,
        updated: TS,
      });
    });
  });

  describe('missing child service', () => {
    it('omits that field when child service is absent', async () => {
      baseService.findById.mockResolvedValue({
        id: 1,
        uuid: 'p1',
        name: 'Parent1',
        created: TS,
        updated: TS,
      });
      const emptyMap = new Map<string, IEntityService<any, any>>();
      const serviceWithMissing = new EagerChildLoadingService(baseService, childSpecs, emptyMap);

      const result = await serviceWithMissing.findById(1);

      expect(result).toEqual({
        id: 1,
        uuid: 'p1',
        name: 'Parent1',
        created: TS,
        updated: TS,
      });
    });
  });

  describe('multiple child types', () => {
    it('attaches multiple child arrays when multiple specs provided', async () => {
      const { grandchildService, multiService } = makeMultiService();

      baseService.findAll.mockResolvedValue([parentRow(1)]);
      childService.findBy.mockResolvedValue([childRow(10, 1, 'A')]);
      grandchildService.findBy.mockResolvedValue([grandchildRow(100, 1, 'X')]);

      const result = await multiService.findAll();

      expect(result[0]).toEqual({
        ...parentRow(1),
        children: [childRow(10, 1, 'A')],
        grandchildren: [grandchildRow(100, 1, 'X')],
      });
      expect(childService.findBy).toHaveBeenCalledOnce();
      expect(grandchildService.findBy).toHaveBeenCalledOnce();
    });
  });
});
