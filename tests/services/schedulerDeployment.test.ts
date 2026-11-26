// §P2 scheduler deployment service self-test: access-permit merge, deployment
// request shape, polling state machine, and the discovery address fix that
// prefers the scheduler's dialable `host` over hostname aliases.
process.env.V_SCHEDULER_URL = 'http://scheduler:8080';
process.env.MCP_NODE_DEPLOY_POLL_MS = '10';
process.env.MCP_NODE_DEPLOY_TIMEOUT_MS = '2000';

const mockSettings: { value: any } = { value: { mcpServers: {} } };

jest.mock('../../src/config/index.js', () => ({
  loadOriginalSettings: jest.fn(() => mockSettings.value),
  saveSettings: jest.fn((next: any) => {
    mockSettings.value = next;
    return true;
  }),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  deployToScheduler,
  ensureDeploymentAccess,
  imageRepositoryOf,
  removeDeployment,
  setDeploymentState,
} from '../../src/services/schedulerDeploymentService.js';
import { discoverNodesFromScheduler } from '../../src/services/remoteNodeService.js';

const TOKEN = 'vos-admin-token';
const TARGET = { kind: 'ssh' as const, id: 'node-orin', profile: 'jetson-orin' };

const jsonOk = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ code: 'OK', data }) });

describe('scheduler deployment service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('derives the image repository by stripping the tag after the last slash', () => {
    expect(imageRepositoryOf('swr.example.com/ictrek/mcp-server-demo:arm64_v1')).toBe(
      'swr.example.com/ictrek/mcp-server-demo',
    );
    expect(imageRepositoryOf('ubuntu')).toBe('ubuntu');
    expect(imageRepositoryOf('registry.local:5000/ictrek/demo')).toBe('registry.local:5000/ictrek/demo');
  });

  it('sets a fresh access permit when none exists (GET 404 → PUT)', async () => {
    mockFetch
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }))
      .mockImplementationOnce(() => Promise.resolve(jsonOk({})));
    await ensureDeploymentAccess(TOKEN, 'com.ictrek.mcphub', TARGET, 'swr.example.com/ictrek/demo');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toContain('/backend-deployment-access/com.ictrek.mcphub');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      targets: [TARGET],
      repositories: ['swr.example.com/ictrek/demo'],
    });
  });

  it('skips the PUT when target and repository are already permitted', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(jsonOk({ targets: [TARGET], repositories: ['swr.example.com/ictrek/demo'] })),
    );
    await ensureDeploymentAccess(TOKEN, 'com.ictrek.mcphub', TARGET, 'swr.example.com/ictrek/demo');
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the GET
  });

  it('merges a new repository into an existing permit without touching other targets', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(jsonOk({
          targets: [{ kind: 'ssh', id: 'other-node', profile: 'jetson-thor' }],
          repositories: ['swr.example.com/ictrek/other'],
        })),
      )
      .mockImplementationOnce(() => Promise.resolve(jsonOk({})));
    await ensureDeploymentAccess(TOKEN, 'com.ictrek.mcphub', TARGET, 'swr.example.com/ictrek/demo');
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.targets).toEqual([
      { kind: 'ssh', id: 'other-node', profile: 'jetson-thor' },
      TARGET,
    ]);
    expect(body.repositories).toEqual(['swr.example.com/ictrek/other', 'swr.example.com/ictrek/demo']);
  });

  it('deploys and resolves once the deployment reports running', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(jsonOk({ id: 'dep-1', state: 'pending', endpoint: null })),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(jsonOk({
          id: 'dep-1',
          state: 'running',
          endpoint: 'http://10.144.144.192:42393',
          host: '10.144.144.192',
          host_port: 42393,
          profile: 'jetson-orin',
          target_id: 'node-orin',
          image: 'swr.example.com/ictrek/mcp-server-demo:arm64_v1',
        })),
      );
    const view = await deployToScheduler(TOKEN, {
      appId: 'com.ictrek.mcphub',
      requestKey: 'mcphub-node-orin-demo',
      target: TARGET,
      image: 'swr.example.com/ictrek/mcp-server-demo:arm64_v1',
      containerPort: 8000,
    });
    expect(view.endpoint).toBe('http://10.144.144.192:42393');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://scheduler:8080/scheduler/api/v1/backend-deployments');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      app_id: 'com.ictrek.mcphub',
      request_key: 'mcphub-node-orin-demo',
      target: TARGET,
      image: 'swr.example.com/ictrek/mcp-server-demo:arm64_v1',
      container_port: 8000,
    });
    expect(mockFetch.mock.calls[1][0]).toContain('/backend-deployments/dep-1');
  });

  it('surfaces a failed deployment with its last error', async () => {
    mockFetch
      .mockImplementationOnce(() => Promise.resolve(jsonOk({ id: 'dep-2', state: 'pending' })))
      .mockImplementationOnce(() =>
        Promise.resolve(jsonOk({ id: 'dep-2', state: 'error', last_error: 'image pull denied' })),
      );
    await expect(deployToScheduler(TOKEN, {
      appId: 'com.ictrek.mcphub',
      requestKey: 'k',
      target: TARGET,
      image: 'swr.example.com/ictrek/broken:v1',
      containerPort: 8000,
    })).rejects.toThrow(/state 'error': image pull denied/);
  });

  it('sends lifecycle actions to the right scheduler endpoints', async () => {
    mockFetch
      .mockImplementationOnce(() => Promise.resolve(jsonOk({ id: 'dep-1', state: 'stopped' })))
      .mockImplementationOnce(() => Promise.resolve(jsonOk({ id: 'dep-1', state: 'running' })))
      .mockImplementationOnce(() => Promise.resolve(jsonOk({ removed: true })));
    await setDeploymentState(TOKEN, 'dep-1', 'stop');
    await setDeploymentState(TOKEN, 'dep-1', 'start');
    await removeDeployment(TOKEN, 'dep-1');
    expect(mockFetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://scheduler:8080/scheduler/api/v1/backend-deployments/dep-1/stop', 'POST'],
      ['http://scheduler:8080/scheduler/api/v1/backend-deployments/dep-1/start', 'POST'],
      ['http://scheduler:8080/scheduler/api/v1/backend-deployments/dep-1', 'DELETE'],
    ]);
  });
});

describe('discovery address mapping (host IP preferred)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('registers address from the dialable host, not the hostname alias', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          code: 'OK',
          data: {
            items: [{
              id: 'node-orin',
              name: '192 orin nx',
              address: 'ubuntu',
              hostname: 'ubuntu',
              host: '10.144.144.192',
              profile: 'jetson-orin',
              status: 'online',
            }],
          },
        }),
      }),
    );
    const nodes = await discoverNodesFromScheduler('vos-token');
    expect(nodes[0].address).toBe('10.144.144.192');
    expect(nodes[0].hostname).toBe('ubuntu');
  });
});
