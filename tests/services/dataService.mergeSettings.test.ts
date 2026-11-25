import { DataService } from '../../src/services/dataService.js';
import type { IUser, McpSettings } from '../../src/types/index.js';

const admin = { username: 'admin', isAdmin: true } as IUser;
const member = { username: 'member', isAdmin: false } as IUser;

const stored = {
  mcpServers: { old: { type: 'stdio', command: 'node' } },
  users: [{ username: 'admin', isAdmin: true }],
  systemConfig: { routing: { enableSmartRouting: false } },
  remoteNodes: [{ id: 'node-a', name: 'node-b', address: '10.0.0.2' }],
  remoteServerBindings: [{ id: 'b-1', nodeId: 'node-a', serverName: 'demo' }],
  bearerKeys: [{ id: 'k-1' }],
} as unknown as McpSettings;

describe('DataService.mergeSettings', () => {
  const service = new DataService();

  it('keeps stored keys an admin save does not mention', () => {
    const merged = service.mergeSettings(stored, {
      mcpServers: { fresh: { type: 'stdio', command: 'node' } },
    } as McpSettings, admin) as unknown as Record<string, unknown>;

    expect(merged.mcpServers).toEqual({ fresh: { type: 'stdio', command: 'node' } });
    // These used to be dropped by a hard-coded whitelist, which silently broke
    // node registration.
    expect(merged.remoteNodes).toEqual(stored.remoteNodes);
    expect(merged.remoteServerBindings).toEqual(stored.remoteServerBindings);
    expect(merged.bearerKeys).toEqual(stored.bearerKeys);
  });

  it('applies keys the caller does supply', () => {
    const nextNodes = [{ id: 'node-b', name: 'node-c', address: '10.0.0.3' }];
    const merged = service.mergeSettings(stored, {
      remoteNodes: nextNodes,
      remoteServerBindings: [],
    } as unknown as McpSettings, admin) as unknown as Record<string, unknown>;

    expect(merged.remoteNodes).toEqual(nextNodes);
    expect(merged.remoteServerBindings).toEqual([]);
    expect(merged.mcpServers).toEqual(stored.mcpServers);
  });

  it('still replaces the keys the dashboard manages wholesale', () => {
    const merged = service.mergeSettings(stored, {
      mcpServers: {},
      systemConfig: { routing: { enableSmartRouting: true } },
    } as unknown as McpSettings, admin) as unknown as Record<string, unknown>;

    expect(merged.mcpServers).toEqual({});
    expect((merged.systemConfig as any).routing.enableSmartRouting).toBe(true);
  });

  it('does not let a non-admin rewrite shared collections', () => {
    const merged = service.mergeSettings(stored, {
      mcpServers: {},
      remoteNodes: [],
    } as unknown as McpSettings, member) as unknown as Record<string, unknown>;

    expect(merged.mcpServers).toEqual(stored.mcpServers);
    expect(merged.remoteNodes).toEqual(stored.remoteNodes);
    expect((merged.userConfigs as any).member).toBeDefined();
  });
});
