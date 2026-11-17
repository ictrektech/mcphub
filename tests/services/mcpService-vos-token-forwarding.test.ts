import { StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';
import type { ServerConfig } from '../../src/types/index.js';

const mockBaseFetch = jest.fn(
  async (_url: string | URL, _init?: RequestInit) =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        cancel: jest.fn(),
      },
    }) as any,
);

jest.mock('../../src/services/oauthService.js', () => ({
  initializeAllOAuthClients: jest.fn(),
}));

jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
}));

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn(() => ''),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
}));

jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any) => data,
  })),
}));

jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn(() => false),
}));

jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({
    logToolCall: jest.fn(),
  })),
}));

jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/proxy.js', () => ({
  createFetchWithProxy: jest.fn(() => mockBaseFetch),
  getProxyConfigFromEnv: jest.fn(() => undefined),
}));

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: jest.fn(() => ({
    findAll: jest.fn(async () => []),
    findById: jest.fn(async () => null),
  })),
  getSystemConfigDao: jest.fn(() => ({
    get: jest.fn(async () => ({})),
  })),
  getBuiltinPromptDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
  })),
  getBuiltinResourceDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
  })),
}));

jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: jest.fn((value: string) => value),
  replaceEnvVars: jest.fn((value: any) => value),
  getNameSeparator: jest.fn(() => '-'),
  default: {
    mcpHubName: 'test-hub',
    mcpHubVersion: '1.0.0',
    initTimeout: 60000,
  },
}));

jest.mock('@modelcontextprotocol/client', () => ({
  ...jest.requireActual('@modelcontextprotocol/client'),
  SSEClientTransport: jest.fn().mockImplementation((url: URL, options: any) => ({
    url,
    options,
  })),
  StreamableHTTPClientTransport: jest.fn().mockImplementation((url: URL, options: any) => ({
    url,
    options,
  })),
}));

jest.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: jest.fn(),
}));

import { RequestContextService } from '../../src/services/requestContextService.js';
import { createOAuthProvider } from '../../src/services/mcpOAuthProvider.js';
import {
  createTransportFromConfig,
  createVosTokenForwardingFetch,
} from '../../src/services/mcpService.js';

const forwardingConfig = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  type: 'streamable-http',
  url: 'https://example.com/mcp',
  forwardVosToken: true,
  ...overrides,
});

describe('VOS token forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    RequestContextService.getInstance().clearRequestContext();
  });

  afterEach(() => {
    RequestContextService.getInstance().clearRequestContext();
  });

  it('replaces the upstream Authorization with the caller token for every init header shape', async () => {
    const shapes: HeadersInit[] = [
      new Headers({ Authorization: 'Bearer stale', 'X-Static': 'yes' }),
      [['Authorization', 'Bearer stale'] as [string, string]],
      { Authorization: 'Bearer stale', 'X-Static': 'yes' },
    ];

    for (const headers of shapes) {
      mockBaseFetch.mockClear();
      const fetch = createVosTokenForwardingFetch(mockBaseFetch as any);
      await RequestContextService.getInstance().runWithCustomRequestContext(
        { headers: { authorization: 'Bearer vos-caller' } },
        () => fetch('https://example.com/mcp', { headers }),
      );
      const sent = new Headers(mockBaseFetch.mock.calls[0][1]?.headers);
      expect(sent.get('authorization')).toBe('Bearer vos-caller');
      // No duplicate, differently-cased authorization survives.
      const names = [...sent.keys()].filter((name) => name.toLowerCase() === 'authorization');
      expect(names).toHaveLength(1);
    }
  });

  it('leaves the request untouched when the caller carries no token', async () => {
    const fetch = createVosTokenForwardingFetch(mockBaseFetch as any);
    await fetch('https://example.com/mcp', {
      headers: { 'X-Static': 'yes' },
    });
    const sent = new Headers(mockBaseFetch.mock.calls[0][1]?.headers);
    expect(sent.has('authorization')).toBe(false);
    expect(sent.get('x-static')).toBe('yes');
  });

  it('wires the caller token into a streamable-http transport and drops the static Authorization', async () => {
    await createTransportFromConfig(
      'gitea-mcp',
      forwardingConfig({ headers: { Authorization: 'Bearer shared-secret', 'X-Static': 'yes' } }),
    );

    const options = (StreamableHTTPClientTransport as jest.Mock).mock.calls[0][1];
    expect(options.authProvider).toBeUndefined();
    expect(createOAuthProvider).not.toHaveBeenCalled();

    const staticHeaders = new Headers(options.requestInit?.headers);
    expect(staticHeaders.has('authorization')).toBe(false);
    expect(staticHeaders.get('x-static')).toBe('yes');

    await RequestContextService.getInstance().runWithCustomRequestContext(
      { headers: { authorization: 'Bearer vos-caller' } },
      () => options.fetch('https://example.com/mcp', { method: 'POST' }),
    );

    const sent = new Headers(mockBaseFetch.mock.calls[0][1]?.headers);
    expect(sent.get('authorization')).toBe('Bearer vos-caller');
  });

  it('wires the caller token into an sse transport and drops the static Authorization', async () => {
    await createTransportFromConfig(
      'gitea-mcp-sse',
      forwardingConfig({ type: 'sse', headers: { Authorization: 'Bearer shared-secret' } }),
    );

    const options = (SSEClientTransport as jest.Mock).mock.calls[0][1];
    expect(options.authProvider).toBeUndefined();
    expect(createOAuthProvider).not.toHaveBeenCalled();

    const sentStatic = new Headers(options.requestInit?.headers);
    expect(sentStatic.has('authorization')).toBe(false);
  });

  it('still creates the OAuth provider for an ordinary http server', async () => {
    await createTransportFromConfig('plain-http', {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
    });
    expect(createOAuthProvider).toHaveBeenCalled();
  });
});
