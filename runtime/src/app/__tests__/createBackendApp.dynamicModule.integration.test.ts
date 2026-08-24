import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createBackendApp } from '../createBackendApp';
import type { DatabaseConnection } from '../../repositories';

const memoryConn = (): DatabaseConnection => ({
  type: 'memory',
  close: () => Promise.resolve(),
});

describe('createBackendApp dynamic module loading', () => {
  let root: string;
  let srcRoot: string;
  let deterministicRoot: string;

  const bootApp = () =>
    createBackendApp(memoryConn(), {
      deterministicRoot,
      srcRoot,
      settingsConfig: { pluralizeTableNames: true },
    });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'create-backend-app-dyn-')));
    srcRoot = path.join(root, 'src');
    deterministicRoot = path.join(root, 'deterministic');
    await mkdir(path.join(srcRoot, 'services'), { recursive: true });
    await mkdir(path.join(srcRoot, 'routes'), { recursive: true });
    await mkdir(deterministicRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads a service class declared via module: with no consumer classRegistry', async () => {
    await writeFile(
      path.join(srcRoot, 'services', 'pinger.mjs'),
      `export class PingerService {
         static dependencies = [];
         ping() { return { pong: true }; }
       }`,
    );
    await writeFile(
      path.join(deterministicRoot, 'backend-app.yaml'),
      `middleware: []\nhandlers: []\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'services.yaml'),
      `services:\n  - name: PingerService\n    module: ./services/pinger.mjs\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'routes.yaml'),
      `routes:\n  - getPing:\n      path: /api/ping\n      method: GET\n      service: PingerService\n      serviceMethod: ping\n`,
    );
    await writeFile(path.join(deterministicRoot, 'datasource_types.yaml'), `types: []\n`);

    const app = await bootApp();

    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it('mounts a custom route declared via routeClass + module', async () => {
    await writeFile(
      path.join(srcRoot, 'services', 'echo.mjs'),
      `export class EchoService {
         static dependencies = [];
         say(word) { return word; }
       }`,
    );
    await writeFile(
      path.join(srcRoot, 'routes', 'echo-route.mjs'),
      `export class EchoRoute {
         constructor(svc) { this.svc = svc; }
         router() {
           return (_req, res) => res.json({ word: this.svc.say('hi') });
         }
       }`,
    );
    await writeFile(
      path.join(deterministicRoot, 'backend-app.yaml'),
      `middleware: []\nhandlers: []\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'services.yaml'),
      `services:\n  - name: EchoService\n    module: ./services/echo.mjs\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'routes.yaml'),
      `routes:\n  - echo:\n      path: /api/echo\n      method: GET\n      routeClass: EchoRoute\n      module: ./routes/echo-route.mjs\n      args:\n        - kind: service\n          name: EchoService\n`,
    );
    await writeFile(path.join(deterministicRoot, 'datasource_types.yaml'), `types: []\n`);

    const app = await bootApp();

    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ word: 'hi' });
  });

  it('treats module: as a bare package specifier (delegates to node_modules resolution, does not path.resolve under srcRoot)', async () => {
    await writeFile(
      path.join(deterministicRoot, 'backend-app.yaml'),
      `middleware: []\nhandlers: []\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'services.yaml'),
      `services:\n  - name: PingerService\n    module: nonexistent-bare-pkg-${Date.now()}\n`,
    );
    await writeFile(path.join(deterministicRoot, 'routes.yaml'), `routes: []\n`);
    await writeFile(path.join(deterministicRoot, 'datasource_types.yaml'), `types: []\n`);

    const err = await bootApp().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(
      err,
      'createBackendApp must throw when the bare specifier is unresolvable',
    ).not.toBeNull();
    expect(err!.message).not.toMatch(/looked for/);
    expect(err!.message).toMatch(/nonexistent-bare-pkg/);
  });

  it('throws a helpful error when a spec declares neither module: nor a classRegistry entry', async () => {
    await writeFile(
      path.join(deterministicRoot, 'backend-app.yaml'),
      `middleware: []\nhandlers: []\n`,
    );
    await writeFile(
      path.join(deterministicRoot, 'services.yaml'),
      `services:\n  - name: GhostService\n`,
    );
    await writeFile(path.join(deterministicRoot, 'routes.yaml'), `routes: []\n`);
    await writeFile(path.join(deterministicRoot, 'datasource_types.yaml'), `types: []\n`);

    await expect(bootApp()).rejects.toThrow(/GhostService/);
  });
});
