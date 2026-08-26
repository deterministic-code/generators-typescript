import { type TestEntity, TS, makeEntityService } from './_entityServiceKit';

describe('EntityService.patch', () => {
  let repository: ReturnType<typeof makeEntityService>['repository'];
  let service: ReturnType<typeof makeEntityService>['service'];
  beforeEach(() => void ({ repository, service } = makeEntityService()));

  it('delegates to update and returns the patched row', async () => {
    const patch = { name: 'patched' };
    const updated: TestEntity = { id: 1, uuid: 'u1', name: 'patched', created: TS, updated: TS };
    repository.update.mockResolvedValue(updated);

    const result = await service.patch(1, patch);

    expect(repository.update).toHaveBeenCalledWith(1, patch);
    expect(result).toBe(updated);
  });

  it('returns null when the resource does not exist', async () => {
    repository.update.mockResolvedValue(null);

    const result = await service.patch(999, { name: 'x' });

    expect(result).toBeNull();
  });
});
