import { IEntityService } from '../interfaces/IEntityService';
import { EagerChildWritingService } from '../EagerChildWritingService';
import { InMemoryDatasource } from '../../repositories/inmemory/InMemoryDatasource';
import { InMemoryCrudRepository } from '../../repositories/inmemory/InMemoryCrudRepository';
import { EntityService } from '../EntityService';
import type { IDatasource } from '../../repositories/IDatasource';
import type { ICrudRepository } from '../../repositories/ICrudRepository';
import { testPrimaryKeys } from '../../repositories/__tests__/testPrimaryKeys';
import { createMockCrudService } from './mockCrudService';
import { createMockCrudRepository } from './mockCrudRepository';

interface Address {
  id: number;
  uuid: string;
  contact_id: number;
  line1: string;
  city: string;
  created: string;
  updated: string;
}

interface Phone {
  id: number;
  uuid: string;
  contact_id: number;
  number: string;
  created: string;
  updated: string;
}

interface ContactBase {
  id: number;
  uuid: string;
  name: string;
  email: string;
  created: string;
  updated: string;
}

interface Contact extends ContactBase {
  addresses?: Address[];
  phones?: Phone[];
}

function withInMemoryTxnRepo(repo: ICrudRepository<any>, txn: IDatasource): ICrudRepository<any> {
  return (repo as unknown as { cloneOnto: (d: IDatasource) => ICrudRepository<any> }).cloneOnto(
    txn,
  );
}

describe('EagerChildWritingService', () => {
  let datasource: InMemoryDatasource;
  let contactRepo: ICrudRepository<ContactBase & { id: number }>;
  let addressRepo: ICrudRepository<Address & { id: number }>;
  let phoneRepo: ICrudRepository<Phone & { id: number }>;
  let baseContactService: EntityService<ContactBase>;
  let baseAddressService: EntityService<Address>;
  let basePhoneService: EntityService<Phone>;
  let service: EagerChildWritingService<ContactBase>;

  beforeEach(async () => {
    datasource = new InMemoryDatasource();
    contactRepo = new InMemoryCrudRepository(datasource, 'contact', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    }) as ICrudRepository<ContactBase & { id: number }>;
    addressRepo = new InMemoryCrudRepository(datasource, 'address', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    }) as ICrudRepository<Address & { id: number }>;
    phoneRepo = new InMemoryCrudRepository(datasource, 'phone', {
      entityName: 'test',
      primaryKeys: testPrimaryKeys('integer'),
    }) as ICrudRepository<Phone & { id: number }>;
    baseContactService = new EntityService(contactRepo);
    baseAddressService = new EntityService(addressRepo);
    basePhoneService = new EntityService(phoneRepo);

    const childBindings = [
      {
        fieldName: 'addresses',
        childTable: 'address',
        fkColumn: 'contact_id',
        service: baseAddressService as IEntityService<any>,
        repository: addressRepo,
        withTxnRepoFn: withInMemoryTxnRepo,
      },
      {
        fieldName: 'phones',
        childTable: 'phone',
        fkColumn: 'contact_id',
        service: basePhoneService as IEntityService<any>,
        repository: phoneRepo,
        withTxnRepoFn: withInMemoryTxnRepo,
      },
    ];

    service = new EagerChildWritingService({
      base: baseContactService,
      datasource,
      parentRepository: contactRepo,
      parentWithTxnRepoFn: withInMemoryTxnRepo,
      children: childBindings,
    });
  });

  describe('create', () => {
    it('inserts parent + children atomically; returned parent has children attached', async () => {
      const input = {
        name: 'John Doe',
        email: 'john@example.com',
        addresses: [
          { line1: '123 Main St', city: 'Springfield' },
          { line1: '456 Oak Ave', city: 'Shelbyville' },
        ],
        phones: [{ number: '555-1234' }],
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>;

      const result = (await service.create(input)) as Contact;

      expect(result.id).toBeDefined();
      expect(result.name).toBe('John Doe');
      expect(result.email).toBe('john@example.com');
      expect(result.addresses).toHaveLength(2);
      expect(result.addresses![0]).toMatchObject({ line1: '123 Main St', city: 'Springfield' });
      expect(result.addresses![0].contact_id).toBe(result.id);
      expect(result.phones).toHaveLength(1);
      expect(result.phones![0].number).toBe('555-1234');
      expect(result.phones![0].contact_id).toBe(result.id);
    });

    it('accepts a singular nested object when isArray is false', async () => {
      const singularService = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            fieldName: 'address',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: baseAddressService as IEntityService<any>,
            repository: addressRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
            isArray: false,
          },
        ],
      });
      const result = (await singularService.create({
        name: 'Ada',
        email: 'ada@example.com',
        address: { line1: '1 Lovelace St', city: 'London' },
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>)) as Contact & {
        address: Address | null;
      };

      expect(result.address).toMatchObject({
        line1: '1 Lovelace St',
        city: 'London',
        contact_id: result.id,
      });
      expect(Array.isArray(result.address)).toBe(false);
    });

    it('packs null when a singular child is omitted on create', async () => {
      const singularService = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            fieldName: 'address',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: baseAddressService as IEntityService<any>,
            repository: addressRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
            isArray: false,
          },
        ],
      });
      const result = (await singularService.create({
        name: 'Ada',
        email: 'ada@example.com',
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>)) as Contact & {
        address: Address | null;
      };
      expect(result.address).toBeNull();
    });

    it('rejects nested rows that include id field', async () => {
      const input = {
        name: 'John Doe',
        email: 'john@example.com',
        addresses: [{ id: 999, line1: '123 Main St', city: 'Springfield' }],
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>;

      await expect(service.create(input)).rejects.toThrow(/nested row cannot have id/i);
    });

    it('overwrites client-supplied FK column on nested rows', async () => {
      const input = {
        name: 'John Doe',
        email: 'john@example.com',
        addresses: [
          {
            line1: '123 Main St',
            city: 'Springfield',
            contact_id: 999,
          } as unknown as Address,
        ],
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>;

      const result = (await service.create(input)) as Contact;

      expect(result.addresses![0].contact_id).toBe(result.id);
      expect(result.addresses![0].contact_id).not.toBe(999);
    });

    it('creates parent and children even without nested arrays', async () => {
      const input = {
        name: 'Jane Doe',
        email: 'jane@example.com',
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>;

      const result = (await service.create(input)) as Contact;

      expect(result.id).toBeDefined();
      expect(result.name).toBe('Jane Doe');
      expect(result.addresses).toEqual([]);
      expect(result.phones).toEqual([]);
    });
  });

  describe('update (PUT semantics)', () => {
    let existingContact: Contact;

    beforeEach(async () => {
      const created = await baseContactService.create({
        name: 'Original',
        email: 'original@example.com',
      });
      existingContact = created as Contact;
      await baseAddressService.create({
        contact_id: existingContact.id,
        line1: 'Old Address',
        city: 'OldCity',
      });
      await basePhoneService.create({
        contact_id: existingContact.id,
        number: '555-0000',
      });
    });

    it('replaces child set: missing children deleted, with-id updated, without-id inserted', async () => {
      const allAddresses = await addressRepo.findAll();
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
        addresses: [
          { id: allAddresses[0].id, line1: 'New Address', city: 'NewCity' },
          { line1: 'Another New', city: 'AnotherCity' },
        ],
        phones: [],
      } as unknown as Partial<Contact>;

      const result = (await service.update(existingContact.id, input)) as Contact;

      expect(result).not.toBeNull();
      expect(result.name).toBe('Updated');
      expect(result.addresses).toHaveLength(2);
      expect(result.addresses!.find((a: Address) => a.id === allAddresses[0].id)?.line1).toBe(
        'New Address',
      );
      expect(result.addresses!.find((a: Address) => a.line1 === 'Another New')).toBeDefined();
      expect(result.phones).toHaveLength(0);
    });

    it('cross-parent guard: rejects update if child FK points to different parent', async () => {
      const otherContact = (await baseContactService.create({
        name: 'Other',
        email: 'other@example.com',
      })) as Contact;
      const otherAddress = await baseAddressService.create({
        contact_id: otherContact.id,
        line1: 'Other Address',
        city: 'OtherCity',
      });

      const input = {
        name: 'Updated',
        email: 'updated@example.com',
        addresses: [{ id: otherAddress.id, line1: 'Stolen', city: 'Stolen' } as unknown as Address],
      } as unknown as Partial<Contact>;

      await expect(service.update(existingContact.id, input)).rejects.toThrow(
        /cross-parent|FK mismatch/i,
      );
    });

    it('returns null when parent does not exist', async () => {
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
      } as unknown as Partial<Contact>;

      const result = await service.update(99999, input);

      expect(result).toBeNull();
    });

    it('rejects a nested row whose id key is present but explicitly undefined', async () => {
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
        addresses: [{ id: undefined, line1: 'x', city: 'y' } as unknown as Address],
      } as unknown as Partial<Contact>;

      await expect(service.update(existingContact.id, input)).rejects.toThrow(
        /id field cannot be null/i,
      );
    });
  });

  describe('patch (PATCH semantics)', () => {
    let existingContact: Contact;

    beforeEach(async () => {
      const created = await baseContactService.create({
        name: 'Original',
        email: 'original@example.com',
      });
      existingContact = created as Contact;
      await baseAddressService.create({
        contact_id: existingContact.id,
        line1: 'Address 1',
        city: 'City 1',
      });
      await baseAddressService.create({
        contact_id: existingContact.id,
        line1: 'Address 2',
        city: 'City 2',
      });
      await basePhoneService.create({
        contact_id: existingContact.id,
        number: '555-1111',
      });
    });

    it('array-absent leaves children untouched', async () => {
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
      } as unknown as Partial<Contact>;

      const result = (await service.patch(existingContact.id, input)) as Contact;

      expect(result).not.toBeNull();
      expect(result.name).toBe('Updated');
      expect(result.addresses).toHaveLength(2);
      expect(result.phones).toHaveLength(1);
    });

    it('omitting children from addresses array deletes them; included children are kept', async () => {
      const allAddresses = await addressRepo.findAll();
      const addressToKeep = allAddresses[0];
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
        addresses: [{ id: addressToKeep.id, line1: 'Updated', city: 'UpdatedCity' }],
      } as unknown as Partial<Contact>;

      const result = (await service.patch(existingContact.id, input)) as Contact;

      expect(result).not.toBeNull();
      expect(result.addresses).toHaveLength(1);
      expect(result.addresses![0].id).toBe(addressToKeep.id);
      expect(result.addresses![0].line1).toBe('Updated');
    });

    it('cross-parent guard on update with mismatched child id', async () => {
      const otherContact = (await baseContactService.create({
        name: 'Other',
        email: 'other@example.com',
      })) as Contact;
      const otherAddress = await baseAddressService.create({
        contact_id: otherContact.id,
        line1: 'Other Address',
        city: 'OtherCity',
      });

      const input = {
        addresses: [{ id: otherAddress.id, line1: 'Stolen', city: 'Stolen' } as unknown as Address],
      } as unknown as Partial<Contact>;

      await expect(service.patch(existingContact.id, input)).rejects.toThrow(
        /cross-parent|FK mismatch/i,
      );
    });

    it('parent-only PATCH does NOT mutate children', async () => {
      const input = {
        name: 'Updated Name Only',
        email: 'updated@example.com',
      } as unknown as Partial<Contact>;

      const result = (await service.patch(existingContact.id, input)) as Contact;

      expect(result).not.toBeNull();
      expect(result.name).toBe('Updated Name Only');
      expect(result.addresses).toHaveLength(2);
      expect(result.phones).toHaveLength(1);
    });

    it('mixes update, insert, and delete-by-omission in PATCH', async () => {
      const allAddresses = await addressRepo.findAll();
      const [addr1, addr2] = allAddresses;

      const input = {
        addresses: [
          { id: addr1.id, line1: 'Updated Address 1', city: 'Updated City' },
          { line1: 'Brand New', city: 'BrandNewCity' },
        ],
      } as unknown as Partial<Contact>;

      const result = (await service.patch(existingContact.id, input)) as Contact;

      expect(result).not.toBeNull();
      expect(result.addresses).toHaveLength(2);
      expect(result.addresses!.find((a: Address) => a.id === addr1.id)?.line1).toBe(
        'Updated Address 1',
      );
      expect(result.addresses!.find((a: Address) => a.line1 === 'Brand New')).toBeDefined();
      expect(result.addresses!.find((a: Address) => a.id === addr2.id)).toBeUndefined();
    });

    it('returns null when parent does not exist', async () => {
      const input = {
        name: 'Updated',
        email: 'updated@example.com',
      } as unknown as Partial<Contact>;

      const result = await service.patch(99999, input);

      expect(result).toBeNull();
    });
  });

  describe('singular nested object patch', () => {
    const singularService = () =>
      new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            fieldName: 'address',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: baseAddressService as IEntityService<any>,
            repository: addressRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
            isArray: false,
          },
        ],
      });

    it('replaces the object, clears on null, and leaves it when omitted', async () => {
      const svc = singularService();
      const created = (await svc.create({
        name: 'Ada',
        email: 'ada@example.com',
        address: { line1: '1 First', city: 'London' },
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>)) as Contact & {
        address: Address | null;
      };
      const id = created.id;

      const replaced = (await svc.patch(id, {
        address: { id: created.address!.id, line1: '2 Second', city: 'Paris' },
      } as unknown as Partial<Contact>)) as Contact & { address: Address | null };
      expect(replaced.address).toMatchObject({ line1: '2 Second', city: 'Paris' });
      expect(Array.isArray(replaced.address)).toBe(false);

      const omitted = (await svc.patch(id, {
        name: 'Ada Lovelace',
      } as unknown as Partial<Contact>)) as Contact & { address: Address | null };
      expect(omitted.address).toMatchObject({ line1: '2 Second' });

      const cleared = (await svc.patch(id, {
        address: null,
      } as unknown as Partial<Contact>)) as Contact & { address: Address | null };
      expect(cleared.address).toBeNull();
      expect(await addressRepo.findAll()).toHaveLength(0);
    });
  });

  describe('atomicity and rollback', () => {
    it('rolls back parent and children on error mid-reconciliation', async () => {
      const input = {
        name: 'John Doe',
        email: 'john@example.com',
        addresses: [
          { line1: '123 Main St', city: 'Springfield' },
          { line1: '456 Oak Ave', city: 'Shelbyville' },
        ],
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>;

      const failingService = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            fieldName: 'addresses',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: {
              ...baseAddressService,
              create: jest.fn().mockRejectedValueOnce(new Error('Child service error')),
            } as unknown as IEntityService<any>,
            repository: addressRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
          },
        ],
      });

      const contactsBefore = await contactRepo.findAll();
      const addressesBefore = await addressRepo.findAll();

      await expect(failingService.create(input)).rejects.toThrow('Child service error');

      const contactsAfter = await contactRepo.findAll();
      const addressesAfter = await addressRepo.findAll();

      expect(contactsAfter).toHaveLength(contactsBefore.length);
      expect(addressesAfter).toHaveLength(addressesBefore.length);
    });
  });

  describe('delete', () => {
    it('cascades direct-fk children created via the eager service', async () => {
      const contact = (await service.create({
        name: 'John Doe',
        email: 'john@example.com',
        addresses: [
          { line1: '123 Main St', city: 'Springfield' },
          { line1: '456 Oak Ave', city: 'Shelbyville' },
        ],
        phones: [{ number: '555-1234' }, { number: '555-5678' }],
      } as unknown as Omit<ContactBase, 'id' | 'uuid' | 'created' | 'updated'>)) as Contact;

      expect(contact.addresses).toHaveLength(2);
      expect(contact.phones).toHaveLength(2);

      const deleted = await service.delete(contact.id);

      expect(deleted).toBe(true);
      expect(await contactRepo.find(contact.id)).toBeNull();
      expect(await addressRepo.findAll()).toEqual([]);
      expect(await phoneRepo.findAll()).toEqual([]);
    });

    it('returns false and leaves DB untouched when parent does not exist', async () => {
      const other = (await service.create({
        name: 'Other',
        email: 'other@example.com',
        addresses: [{ line1: 'Stay Put', city: 'Staytown' }],
        phones: [{ number: '555-9999' }],
      } as any)) as Contact;

      const deleted = await service.delete(99999);

      expect(deleted).toBe(false);
      expect(await contactRepo.find(other.id)).not.toBeNull();
      expect(await addressRepo.findAll()).toHaveLength(1);
      expect(await phoneRepo.findAll()).toHaveLength(1);
    });

    it('processes bindings in reverse order (last-bound first)', async () => {
      const order: string[] = [];
      const spy = jest
        .spyOn(InMemoryCrudRepository.prototype, 'delete')
        .mockImplementation(async function (this: InMemoryCrudRepository<any>, id: number) {
          order.push((this as unknown as { tableName: string }).tableName);
          const idx = (this as any).table.rows.findIndex((r: any) => r.id === id);
          if (idx === -1) return false;
          (this as any).table.rows.splice(idx, 1);
          return true;
        });

      try {
        const contact = (await service.create({
          name: 'Order Witness',
          email: 'order@example.com',
          addresses: [{ line1: 'A1', city: 'C1' }],
          phones: [{ number: '555-1' }],
        } as any)) as Contact;

        order.length = 0;
        await service.delete(contact.id);
      } finally {
        spy.mockRestore();
      }

      const firstPhone = order.indexOf('phone');
      const firstAddress = order.indexOf('address');
      const contactIdx = order.indexOf('contact');
      expect(firstPhone).toBeGreaterThanOrEqual(0);
      expect(firstAddress).toBeGreaterThanOrEqual(0);
      expect(contactIdx).toBeGreaterThanOrEqual(0);
      expect(firstPhone).toBeLessThan(firstAddress);
      expect(firstAddress).toBeLessThan(contactIdx);
    });

    it('rolls back the entire cascade if a child delete throws mid-flight', async () => {
      const contact = (await service.create({
        name: 'Atomic',
        email: 'atomic@example.com',
        addresses: [
          { line1: 'Addr1', city: 'CityA' },
          { line1: 'Addr2', city: 'CityB' },
        ],
        phones: [{ number: '555-A' }, { number: '555-B' }],
      } as any)) as Contact;

      const contactsBefore = await contactRepo.findAll();
      const addressesBefore = await addressRepo.findAll();
      const phonesBefore = await phoneRepo.findAll();

      const originalDelete = InMemoryCrudRepository.prototype.delete;
      const spy = jest
        .spyOn(InMemoryCrudRepository.prototype, 'delete')
        .mockImplementation(async function (this: InMemoryCrudRepository<any>, id: number) {
          if ((this as unknown as { tableName: string }).tableName === 'phone') {
            throw new Error('forced phone delete failure');
          }
          return originalDelete.call(this, id);
        });

      try {
        await expect(service.delete(contact.id)).rejects.toThrow('forced phone delete failure');
      } finally {
        spy.mockRestore();
      }

      expect(await contactRepo.findAll()).toEqual(contactsBefore);
      expect(await addressRepo.findAll()).toEqual(addressesBefore);
      expect(await phoneRepo.findAll()).toEqual(phonesBefore);
    });
  });

  describe('read methods passthrough', () => {
    beforeEach(async () => {
      await baseContactService.create({
        name: 'John Doe',
        email: 'john@example.com',
      });
    });

    it('findById passes through', async () => {
      const result = await service.findById(1);

      expect(result).not.toBeNull();
      expect((result as Contact).name).toBe('John Doe');
    });

    it('findAll passes through', async () => {
      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect((result[0] as Contact).name).toBe('John Doe');
    });

    it('findBy passes through', async () => {
      const result = await service.findBy([{ name: 'name', value: 'John Doe' }]);

      expect(result).toHaveLength(1);
      expect((result[0] as Contact).email).toBe('john@example.com');
    });

    it('primaryKey getter reflects the base service key', () => {
      expect(service.primaryKey.column).toBe('id');
    });

    it('query delegates to the base (in-memory backend refuses raw SQL)', async () => {
      await expect(service.query('SELECT 1', [])).rejects.toThrow(/does not support raw SQL/i);
    });

    it('find delegates to the base (in-memory backend refuses raw SQL)', async () => {
      await expect(service.find('SELECT 1', [])).rejects.toThrow(/does not support raw SQL/i);
    });

    it('updateBy delegates to the base service', async () => {
      const count = await service.updateBy([{ name: 'name', value: 'John Doe' }], {
        email: 'renamed@example.com',
      } as Partial<ContactBase>);

      expect(count).toBe(1);
      const reloaded = await contactRepo.findBy('name', 'John Doe');
      expect(reloaded[0].email).toBe('renamed@example.com');
    });

    it('deleteBy delegates to the base service', async () => {
      const count = await service.deleteBy([{ name: 'name', value: 'John Doe' }]);

      expect(count).toBe(1);
      expect(await contactRepo.findAll()).toHaveLength(0);
    });
  });

  describe('M2M binding', () => {
    interface Tag {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }
    interface ContactTag {
      id: number;
      uuid: string;
      contact_id: number;
      tag_id: number;
      created: string;
      updated: string;
    }

    let tagRepo: ICrudRepository<Tag & { id: number }>;
    let junctionRepo: ICrudRepository<ContactTag & { id: number }>;
    let baseTagService: EntityService<Tag>;
    let m2mService: EagerChildWritingService<ContactBase>;

    beforeEach(async () => {
      tagRepo = new InMemoryCrudRepository(datasource, 'tag', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<Tag & { id: number }>;
      junctionRepo = new InMemoryCrudRepository(datasource, 'contact_tag', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<ContactTag & { id: number }>;
      baseTagService = new EntityService(tagRepo);

      m2mService = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            kind: 'm2m',
            fieldName: 'tags',
            childTable: 'tag',
            junctionTable: 'contact_tag',
            parentFkColumn: 'contact_id',
            targetFkColumn: 'tag_id',
            service: baseTagService as IEntityService<any>,
            repository: tagRepo,
            junctionRepository: junctionRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
          },
        ],
      });
    });

    it('create with link-by-id rows: inserts junction rows pointing to existing targets', async () => {
      const t1 = await tagRepo.add({ name: 'urgent' } as any);
      const t2 = await tagRepo.add({ name: 'work' } as any);

      const result = (await m2mService.create({
        name: 'Alice',
        email: 'alice@example.com',
        tags: [{ id: t1.id }, { id: t2.id }],
      } as any)) as Contact & { tags: Tag[] };

      expect(result.tags).toHaveLength(2);
      const ids = result.tags.map((t) => t.id).sort((a, b) => a - b);
      expect(ids).toEqual([t1.id, t2.id].sort((a, b) => a - b));

      const junctions = await junctionRepo.findBy('contact_id', result.id);
      expect(junctions).toHaveLength(2);
    });

    it('create with no-id rows: creates new target rows then links via junction', async () => {
      const result = (await m2mService.create({
        name: 'Bob',
        email: 'bob@example.com',
        tags: [{ name: 'home' }, { name: 'errands' }],
      } as any)) as Contact & { tags: Tag[] };

      expect(result.tags).toHaveLength(2);
      const allTags = await tagRepo.findAll();
      expect(allTags.map((t) => t.name).sort()).toEqual(['errands', 'home']);

      const junctions = await junctionRepo.findBy('contact_id', result.id);
      expect(junctions).toHaveLength(2);
    });

    it('update reconciles: drops links not in incoming, adds new ones', async () => {
      const t1 = await tagRepo.add({ name: 'a' } as any);
      const t2 = await tagRepo.add({ name: 'b' } as any);
      const t3 = await tagRepo.add({ name: 'c' } as any);

      const created = (await m2mService.create({
        name: 'Carol',
        email: 'carol@example.com',
        tags: [{ id: t1.id }, { id: t2.id }],
      } as any)) as Contact & { id: number };

      const updated = (await m2mService.update(created.id, {
        tags: [{ id: t2.id }, { id: t3.id }],
      } as any)) as Contact & { tags: Tag[] };

      const linkedIds = updated.tags.map((t) => t.id).sort((a, b) => a - b);
      expect(linkedIds).toEqual([t2.id, t3.id].sort((a, b) => a - b));

      const junctions = await junctionRepo.findBy('contact_id', created.id);
      expect(junctions).toHaveLength(2);
      const junctionTargets = junctions.map((j) => j.tag_id).sort((a, b) => a - b);
      expect(junctionTargets).toEqual([t2.id, t3.id].sort((a, b) => a - b));
    });

    it('update with empty tags array drops all links', async () => {
      const t1 = await tagRepo.add({ name: 'a' } as any);
      const created = (await m2mService.create({
        name: 'Dave',
        email: 'dave@example.com',
        tags: [{ id: t1.id }],
      } as any)) as Contact & { id: number };

      const updated = (await m2mService.update(created.id, { tags: [] } as any)) as Contact & {
        tags: Tag[];
      };

      expect(updated.tags).toEqual([]);
      const junctions = await junctionRepo.findBy('contact_id', created.id);
      expect(junctions).toHaveLength(0);
    });

    it('update without tags key preserves existing links', async () => {
      const t1 = await tagRepo.add({ name: 'a' } as any);
      const created = (await m2mService.create({
        name: 'Eve',
        email: 'eve@example.com',
        tags: [{ id: t1.id }],
      } as any)) as Contact & { id: number };

      const updated = (await m2mService.update(created.id, { name: 'Eve!' } as any)) as Contact & {
        tags: Tag[];
      };

      expect(updated.tags).toHaveLength(1);
      expect(updated.tags[0].id).toBe(t1.id);
    });

    it('delete cascades junction rows only; m2m target rows are preserved', async () => {
      const sharedTag = await tagRepo.add({ name: 'shared' } as any);

      const alice = (await m2mService.create({
        name: 'Alice',
        email: 'alice@example.com',
        tags: [{ id: sharedTag.id }, { name: 'alice-only' }],
      } as any)) as Contact & { id: number; tags: Array<Tag & { id: number }> };

      const bob = (await m2mService.create({
        name: 'Bob',
        email: 'bob@example.com',
        tags: [{ id: sharedTag.id }],
      } as any)) as Contact & { id: number };

      const aliceOnlyTagId = alice.tags.find((t) => t.name === 'alice-only')!.id;
      const tagIdsBefore = (await tagRepo.findAll()).map((t) => t.id).sort((a, b) => a - b);

      const deleted = await m2mService.delete(alice.id);

      expect(deleted).toBe(true);
      expect(await contactRepo.find(alice.id)).toBeNull();
      const aliceJunctions = await junctionRepo.findBy('contact_id', alice.id);
      expect(aliceJunctions).toHaveLength(0);

      const tagIdsAfter = (await tagRepo.findAll()).map((t) => t.id).sort((a, b) => a - b);
      expect(tagIdsAfter).toEqual(tagIdsBefore);
      expect(await tagRepo.find(sharedTag.id)).not.toBeNull();
      expect(await tagRepo.find(aliceOnlyTagId)).not.toBeNull();

      const bobJunctions = await junctionRepo.findBy('contact_id', bob.id);
      expect(bobJunctions).toHaveLength(1);
      expect(bobJunctions[0].tag_id).toBe(sharedTag.id);
    });

    it('create links a junction to a dangling target id, dropping it from the response', async () => {
      const result = (await m2mService.create({
        name: 'Frank',
        email: 'frank@example.com',
        tags: [{ id: 99999 }],
      } as any)) as Contact & { id: number; tags: Tag[] };

      expect(result.tags).toEqual([]);
      const junctions = await junctionRepo.findBy('contact_id', result.id);
      expect(junctions).toHaveLength(1);
      expect(junctions[0].tag_id).toBe(99999);
    });

    it('update links a junction to a dangling target id, dropping it from the response', async () => {
      const created = (await m2mService.create({
        name: 'Grace',
        email: 'grace@example.com',
        tags: [],
      } as any)) as Contact & { id: number };

      const updated = (await m2mService.update(created.id, {
        tags: [{ id: 88888 }],
      } as any)) as Contact & { tags: Tag[] };

      expect(updated.tags).toEqual([]);
      const junctions = await junctionRepo.findBy('contact_id', created.id);
      expect(junctions.map((j) => j.tag_id)).toEqual([88888]);
    });
  });

  describe('depth-N (recursive bindings)', () => {
    interface Note {
      id: number;
      uuid: string;
      address_id: number;
      body: string;
      created: string;
      updated: string;
    }

    let noteRepo: ICrudRepository<Note & { id: number }>;
    let baseNoteService: EntityService<Note>;
    let depth2Service: EagerChildWritingService<ContactBase>;

    beforeEach(async () => {
      noteRepo = new InMemoryCrudRepository(datasource, 'note', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<Note & { id: number }>;
      baseNoteService = new EntityService(noteRepo);

      // contact (root) → addresses (direct-fk) → notes (direct-fk).
      depth2Service = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            kind: 'direct-fk',
            fieldName: 'addresses',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: baseAddressService as IEntityService<any>,
            repository: addressRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
            children: [
              {
                kind: 'direct-fk',
                fieldName: 'notes',
                childTable: 'note',
                fkColumn: 'address_id',
                service: baseNoteService as IEntityService<any>,
                repository: noteRepo,
                withTxnRepoFn: withInMemoryTxnRepo,
              },
            ],
          },
        ],
      });
    });

    it('create depth-2: inserts root + child + grandchild atomically with FKs wired', async () => {
      const result = (await depth2Service.create({
        name: 'Frank',
        email: 'frank@example.com',
        addresses: [
          {
            line1: '1 Lake St',
            city: 'Lake City',
            notes: [{ body: 'first note' }, { body: 'second note' }],
          },
        ],
      } as any)) as Contact & { addresses: Array<Address & { notes: Note[] }> };

      expect(result.addresses).toHaveLength(1);
      const addr = result.addresses[0];
      expect(addr.contact_id).toBe(result.id);
      expect(addr.notes).toHaveLength(2);
      expect(addr.notes[0]).toMatchObject({ body: 'first note' });
      expect(addr.notes[0].address_id).toBe(addr.id);

      const persistedNotes = await noteRepo.findBy('address_id', addr.id);
      expect(persistedNotes).toHaveLength(2);
    });

    it('create depth-2 omitted at level 2: address inserts, notes default to []', async () => {
      const result = (await depth2Service.create({
        name: 'Greg',
        email: 'greg@example.com',
        addresses: [{ line1: '2 Hill Rd', city: 'Hilltown' }],
      } as any)) as Contact & { addresses: Array<Address & { notes: Note[] }> };

      expect(result.addresses).toHaveLength(1);
      expect(result.addresses[0].notes).toEqual([]);
    });

    it('update depth-2: reconciles grandchildren by id (delete dropped, update kept, create new)', async () => {
      const created = (await depth2Service.create({
        name: 'Hank',
        email: 'hank@example.com',
        addresses: [
          {
            line1: '3 River Way',
            city: 'Riverside',
            notes: [{ body: 'A' }, { body: 'B' }],
          },
        ],
      } as any)) as Contact & {
        id: number;
        addresses: Array<Address & { id: number; notes: Array<Note & { id: number }> }>;
      };

      const addrId = created.addresses[0].id;
      const noteAId = created.addresses[0].notes[0].id;
      // drop B, keep A (with edited body), add C
      const updated = (await depth2Service.update(created.id, {
        addresses: [
          {
            id: addrId,
            line1: '3 River Way',
            city: 'Riverside',
            notes: [{ id: noteAId, body: 'A-edited' }, { body: 'C' }],
          },
        ],
      } as any)) as Contact & {
        addresses: Array<Address & { notes: Array<Note & { id: number }> }>;
      };

      const notes = updated.addresses[0].notes;
      expect(notes).toHaveLength(2);
      const noteBodies = notes.map((n) => n.body).sort();
      expect(noteBodies).toEqual(['A-edited', 'C']);

      const persisted = await noteRepo.findBy('address_id', addrId);
      expect(persisted).toHaveLength(2);
    });

    it('update depth-2 without grandchild key preserves existing grandchildren', async () => {
      const created = (await depth2Service.create({
        name: 'Ivy',
        email: 'ivy@example.com',
        addresses: [
          {
            line1: '4 Forest Ln',
            city: 'Forestville',
            notes: [{ body: 'keep me' }],
          },
        ],
      } as any)) as Contact & { id: number; addresses: Array<Address & { id: number }> };

      const addrId = created.addresses[0].id;
      const updated = (await depth2Service.update(created.id, {
        addresses: [{ id: addrId, line1: '4 Forest Ln', city: 'Forestville' }],
      } as any)) as Contact & { addresses: Array<Address & { notes: Note[] }> };

      expect(updated.addresses[0].notes).toHaveLength(1);
      expect(updated.addresses[0].notes[0].body).toBe('keep me');
    });

    it('delete depth-2 cascades through grandchildren (root → child → grandchild)', async () => {
      const created = (await depth2Service.create({
        name: 'Jane',
        email: 'jane@example.com',
        addresses: [
          {
            line1: '5 Bay St',
            city: 'Bayside',
            notes: [{ body: 'note-1a' }, { body: 'note-1b' }],
          },
          {
            line1: '6 Cove Rd',
            city: 'Coveside',
            notes: [{ body: 'note-2a' }],
          },
        ],
      } as any)) as Contact & {
        id: number;
        addresses: Array<Address & { id: number; notes: Array<Note & { id: number }> }>;
      };

      const addr1Id = created.addresses[0].id;
      const addr2Id = created.addresses[1].id;
      expect(await noteRepo.findBy('address_id', addr1Id)).toHaveLength(2);
      expect(await noteRepo.findBy('address_id', addr2Id)).toHaveLength(1);

      // sibling parent must survive; we only kill `created`.
      const survivor = (await depth2Service.create({
        name: 'Survivor',
        email: 's@example.com',
        addresses: [{ line1: 'Survives', city: 'Town', notes: [{ body: 'still here' }] }],
      } as any)) as Contact & {
        id: number;
        addresses: Array<Address & { id: number; notes: Array<Note & { id: number }> }>;
      };
      const survivorAddrId = survivor.addresses[0].id;
      const survivorNoteId = survivor.addresses[0].notes[0].id;

      const deleted = await depth2Service.delete(created.id);

      expect(deleted).toBe(true);
      expect(await contactRepo.find(created.id)).toBeNull();
      expect(await addressRepo.findBy('contact_id', created.id)).toEqual([]);
      expect(await noteRepo.findBy('address_id', addr1Id)).toEqual([]);
      expect(await noteRepo.findBy('address_id', addr2Id)).toEqual([]);

      expect(await contactRepo.find(survivor.id)).not.toBeNull();
      expect(await addressRepo.find(survivorAddrId)).not.toBeNull();
      expect(await noteRepo.find(survivorNoteId)).not.toBeNull();
    });

    it('update dropping a child cascades its grandchildren away', async () => {
      const created = (await depth2Service.create({
        name: 'Kim',
        email: 'kim@example.com',
        addresses: [
          { line1: 'Keep', city: 'KeepCity', notes: [{ body: 'keep-note' }] },
          {
            line1: 'Drop',
            city: 'DropCity',
            notes: [{ body: 'drop-note-1' }, { body: 'drop-note-2' }],
          },
        ],
      } as any)) as Contact & {
        id: number;
        addresses: Array<Address & { id: number; notes: Array<Note & { id: number }> }>;
      };

      const keepAddr = created.addresses.find((a) => a.line1 === 'Keep')!;
      const dropAddr = created.addresses.find((a) => a.line1 === 'Drop')!;
      expect(await noteRepo.findBy('address_id', dropAddr.id)).toHaveLength(2);

      const updated = (await depth2Service.update(created.id, {
        addresses: [
          {
            id: keepAddr.id,
            line1: 'Keep',
            city: 'KeepCity',
            notes: [{ id: keepAddr.notes[0].id, body: 'keep-note' }],
          },
        ],
      } as any)) as Contact & { addresses: Array<Address & { id: number }> };

      expect(updated.addresses).toHaveLength(1);
      expect(updated.addresses[0].id).toBe(keepAddr.id);
      expect(await addressRepo.find(dropAddr.id)).toBeNull();
      expect(await noteRepo.findBy('address_id', dropAddr.id)).toEqual([]);
    });

    it('patch omitting the child array loads existing children with their grandchildren', async () => {
      const created = (await depth2Service.create({
        name: 'Lena',
        email: 'lena@example.com',
        addresses: [{ line1: 'Home', city: 'Town', notes: [{ body: 'n1' }, { body: 'n2' }] }],
      } as any)) as Contact & {
        id: number;
        addresses: Array<Address & { id: number }>;
      };
      const addrId = created.addresses[0].id;

      const patched = (await depth2Service.patch(created.id, {
        name: 'Lena Renamed',
      } as any)) as Contact & {
        addresses: Array<Address & { id: number; notes: Note[] }>;
      };

      expect(patched.name).toBe('Lena Renamed');
      expect(patched.addresses).toHaveLength(1);
      expect(patched.addresses[0].id).toBe(addrId);
      expect(patched.addresses[0].notes.map((n) => n.body).sort()).toEqual(['n1', 'n2']);
    });
  });

  describe('M2M binding with nested children', () => {
    interface Tag {
      id: number;
      uuid: string;
      name: string;
      created: string;
      updated: string;
    }
    interface Label {
      id: number;
      uuid: string;
      tag_id: number;
      text: string;
      created: string;
      updated: string;
    }

    let tagRepo: ICrudRepository<Tag & { id: number }>;
    let junctionRepo: ICrudRepository<any>;
    let labelRepo: ICrudRepository<Label & { id: number }>;
    let nestedM2mService: EagerChildWritingService<ContactBase>;

    beforeEach(() => {
      tagRepo = new InMemoryCrudRepository(datasource, 'tag', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<Tag & { id: number }>;
      junctionRepo = new InMemoryCrudRepository(datasource, 'contact_tag', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<any>;
      labelRepo = new InMemoryCrudRepository(datasource, 'label', {
        entityName: 'test',
        primaryKeys: testPrimaryKeys('integer'),
      }) as ICrudRepository<Label & { id: number }>;

      nestedM2mService = new EagerChildWritingService({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            kind: 'm2m',
            fieldName: 'tags',
            childTable: 'tag',
            junctionTable: 'contact_tag',
            parentFkColumn: 'contact_id',
            targetFkColumn: 'tag_id',
            service: new EntityService(tagRepo) as IEntityService<any>,
            repository: tagRepo,
            junctionRepository: junctionRepo,
            withTxnRepoFn: withInMemoryTxnRepo,
            children: [
              {
                kind: 'direct-fk',
                fieldName: 'labels',
                childTable: 'label',
                fkColumn: 'tag_id',
                service: new EntityService(labelRepo) as IEntityService<any>,
                repository: labelRepo,
                withTxnRepoFn: withInMemoryTxnRepo,
              },
            ],
          },
        ],
      });
    });

    it('create builds target rows and their nested grandchildren', async () => {
      const result = (await nestedM2mService.create({
        name: 'Mia',
        email: 'mia@example.com',
        tags: [{ name: 'work', labels: [{ text: 'red' }, { text: 'blue' }] }],
      } as any)) as Contact & { tags: Array<Tag & { labels: Label[] }> };

      expect(result.tags).toHaveLength(1);
      const tag = result.tags[0];
      expect(tag.name).toBe('work');
      expect(tag.labels.map((l) => l.text).sort()).toEqual(['blue', 'red']);
      expect(await labelRepo.findBy('tag_id', tag.id)).toHaveLength(2);
    });

    it('update reconciles the nested grandchildren of a linked target', async () => {
      const created = (await nestedM2mService.create({
        name: 'Nora',
        email: 'nora@example.com',
        tags: [{ name: 'home', labels: [{ text: 'old' }] }],
      } as any)) as Contact & { id: number; tags: Array<Tag & { id: number }> };
      const tagId = created.tags[0].id;

      const updated = (await nestedM2mService.update(created.id, {
        tags: [{ id: tagId, labels: [{ text: 'fresh' }] }],
      } as any)) as Contact & { tags: Array<Tag & { labels: Label[] }> };

      expect(updated.tags).toHaveLength(1);
      expect(updated.tags[0].labels.map((l) => l.text)).toEqual(['fresh']);
    });

    it('update omitting tags loads linked targets with their nested grandchildren', async () => {
      const created = (await nestedM2mService.create({
        name: 'Omar',
        email: 'omar@example.com',
        tags: [{ name: 'keep', labels: [{ text: 'persisted' }] }],
      } as any)) as Contact & { id: number };

      const updated = (await nestedM2mService.update(created.id, {
        name: 'Omar Renamed',
      } as any)) as Contact & { tags: Array<Tag & { labels: Label[] }> };

      expect(updated.name).toBe('Omar Renamed');
      expect(updated.tags).toHaveLength(1);
      expect(updated.tags[0].labels.map((l) => l.text)).toEqual(['persisted']);
    });

    it('update omitting tags returns [] when the parent has no linked targets', async () => {
      const created = (await nestedM2mService.create({
        name: 'Pia',
        email: 'pia@example.com',
        tags: [],
      } as any)) as Contact & { id: number };

      const updated = (await nestedM2mService.update(created.id, {
        name: 'Pia Renamed',
      } as any)) as Contact & { tags: Tag[] };

      expect(updated.tags).toEqual([]);
    });
  });

  describe('defensive null handling via mocked collaborators', () => {
    function mockRow(id: number) {
      return { id, uuid: `u${id}`, name: 'x', email: 'x@example.com', created: 't', updated: 't' };
    }

    it('update returns null when the parent update resolves null despite an existing row', async () => {
      const mockBase = createMockCrudService<ContactBase>('integer');
      mockBase.findById.mockResolvedValue(mockRow(1) as unknown as ContactBase);
      mockBase.update.mockResolvedValue(null);

      const svc = new EagerChildWritingService<ContactBase>({
        base: mockBase,
        datasource,
        parentRepository: createMockCrudRepository<ContactBase & { id: number }>('integer'),
        parentWithTxnRepoFn: (repo) => repo,
        children: [],
      });

      const result = await svc.update(1, { name: 'renamed' } as Partial<ContactBase>);

      expect(result).toBeNull();
    });

    it('patch returns null when the parent update resolves null despite an existing row', async () => {
      const mockBase = createMockCrudService<ContactBase>('integer');
      mockBase.findById.mockResolvedValue(mockRow(1) as unknown as ContactBase);
      mockBase.update.mockResolvedValue(null);

      const svc = new EagerChildWritingService<ContactBase>({
        base: mockBase,
        datasource,
        parentRepository: createMockCrudRepository<ContactBase & { id: number }>('integer'),
        parentWithTxnRepoFn: (repo) => repo,
        children: [],
      });

      const result = await svc.patch(1, { name: 'renamed' } as Partial<ContactBase>);

      expect(result).toBeNull();
    });

    it('reconcile skips a child whose update resolves null', async () => {
      const parent = (await baseContactService.create({
        name: 'Quinn',
        email: 'quinn@example.com',
      })) as Contact;

      const mockChild = createMockCrudService<Address>('integer');
      mockChild.findBy.mockResolvedValue([{ id: 5, contact_id: parent.id } as unknown as Address]);
      mockChild.update.mockResolvedValue(null);

      const svc = new EagerChildWritingService<ContactBase>({
        base: baseContactService,
        datasource,
        parentRepository: contactRepo,
        parentWithTxnRepoFn: withInMemoryTxnRepo,
        children: [
          {
            fieldName: 'addresses',
            childTable: 'address',
            fkColumn: 'contact_id',
            service: mockChild,
            repository: createMockCrudRepository<Address & { id: number }>('integer'),
            withTxnRepoFn: (repo) => repo,
          },
        ],
      });

      const result = (await svc.update(parent.id, {
        addresses: [{ id: 5, line1: 'x', city: 'y' }],
      } as unknown as Partial<Contact>)) as Contact;

      expect(result.addresses).toEqual([]);
      expect(mockChild.update).toHaveBeenCalled();
    });
  });
});
