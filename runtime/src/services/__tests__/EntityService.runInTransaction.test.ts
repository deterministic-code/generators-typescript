import { EntityService } from '../EntityService';
import { InMemoryCrudRepository } from '../../repositories/inmemory/InMemoryCrudRepository';
import { InMemoryDatasource } from '../../repositories/inmemory/InMemoryDatasource';
import type { ICrudRepository } from '../../repositories/ICrudRepository';
import type { IDatasource } from '../../repositories/IDatasource';
import { testPrimaryKeys } from '../../repositories/__tests__/testPrimaryKeys';

const withTxnRepo = (repo: ICrudRepository<any>, txn: IDatasource): ICrudRepository<any> =>
  (repo as unknown as { cloneOnto: (d: IDatasource) => ICrudRepository<any> }).cloneOnto(txn);

interface Contact {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  name: string;
}

interface Address {
  id: number;
  uuid: string;
  created: string;
  updated: string;
  street: string;
}

function makeFixture(): {
  datasource: InMemoryDatasource;
  contactRepo: InMemoryCrudRepository<Contact>;
  addressRepo: InMemoryCrudRepository<Address>;
  contactSvc: EntityService<Contact>;
  addressSvc: EntityService<Address>;
} {
  const datasource = new InMemoryDatasource();
  const contactRepo = new InMemoryCrudRepository<Contact>(datasource, 'contact', {
    entityName: 'contact',
    primaryKeys: testPrimaryKeys('integer'),
  });
  const addressRepo = new InMemoryCrudRepository<Address>(datasource, 'address', {
    entityName: 'address',
    primaryKeys: testPrimaryKeys('integer'),
  });
  return {
    datasource,
    contactRepo,
    addressRepo,
    contactSvc: new EntityService(contactRepo),
    addressSvc: new EntityService(addressRepo),
  };
}

describe('EntityService.runInTransaction', () => {
  it('commit case: creates rows in two services within transaction and sees them after commit', async () => {
    const { datasource, addressRepo, contactSvc, addressSvc } = makeFixture();

    await contactSvc.runInTransaction(datasource, withTxnRepo, async (txnContactSvc) => {
      const txnAddressSvc = new EntityService(withTxnRepo(addressRepo, datasource));

      const contact = await txnContactSvc.create({ name: 'Alice' } as Omit<
        Contact,
        'id' | 'uuid' | 'created' | 'updated'
      >);
      const address = await txnAddressSvc.create({ street: '123 Main St' } as Omit<
        Address,
        'id' | 'uuid' | 'created' | 'updated'
      >);

      expect(contact.id).toBe(1);
      expect(address.id).toBe(1);
    });

    const contacts = await contactSvc.findAll();
    const addresses = await addressSvc.findAll();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe('Alice');
    expect(addresses).toHaveLength(1);
    expect(addresses[0].street).toBe('123 Main St');
  });

  it('rollback case: throws inside callback and rolls back changes in both services', async () => {
    const { datasource, addressRepo, contactSvc, addressSvc } = makeFixture();

    const testError = new Error('Test rollback');

    await expect(
      contactSvc.runInTransaction(datasource, withTxnRepo, async (txnContactSvc) => {
        const txnAddressSvc = new EntityService(withTxnRepo(addressRepo, datasource));

        await txnContactSvc.create({ name: 'Alice' } as Omit<
          Contact,
          'id' | 'uuid' | 'created' | 'updated'
        >);
        await txnAddressSvc.create({ street: '123 Main St' } as Omit<
          Address,
          'id' | 'uuid' | 'created' | 'updated'
        >);

        throw testError;
      }),
    ).rejects.toBe(testError);

    const contacts = await contactSvc.findAll();
    const addresses = await addressSvc.findAll();
    expect(contacts).toHaveLength(0);
    expect(addresses).toHaveLength(0);
  });

  it('return value propagation: callback return value is propagated to caller', async () => {
    const { datasource, contactSvc } = makeFixture();

    const result = await contactSvc.runInTransaction(
      datasource,
      withTxnRepo,
      async (txnContactSvc) => {
        await txnContactSvc.create({ name: 'Alice' } as Omit<
          Contact,
          'id' | 'uuid' | 'created' | 'updated'
        >);
        return 'SUCCESS';
      },
    );

    expect(result).toBe('SUCCESS');
  });

  it('error propagation: original error from callback is re-thrown unchanged', async () => {
    const { datasource, contactSvc } = makeFixture();

    const originalError = new Error('Original error');

    await expect(
      contactSvc.runInTransaction(datasource, withTxnRepo, async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);
  });
});
