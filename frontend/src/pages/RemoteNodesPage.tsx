import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/fetchInterceptor';

interface RemoteNode {
  id: string;
  name: string;
  baseUrl: string;
  profile?: string;
  enabled?: boolean;
  hasToken: boolean;
  createdAt?: string;
}

interface RemoteServer {
  name: string;
  description?: string;
  visibility?: string;
  status?: string;
  enabled?: boolean;
  mcpPath?: string;
}

interface DiscoveredNode {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  profile?: string;
  status?: string;
  arch?: string;
  gpuModel?: string;
  alreadyManaged: boolean;
}

interface ApiResult<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const emptyForm = { id: '', name: '', baseUrl: '', token: '', profile: '', enabled: true };

const RemoteNodesPage: React.FC = () => {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<RemoteNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ ...emptyForm });
  const [editing, setEditing] = useState(false);
  const [servers, setServers] = useState<Record<string, RemoteServer[]>>({});
  const [serversLoading, setServersLoading] = useState<Record<string, boolean>>({});
  const [discovered, setDiscovered] = useState<DiscoveredNode[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await apiGet<ApiResult<RemoteNode[]>>('/remote-nodes');
    if (result.success && result.data) setNodes(result.data);
    else setError(result.message ?? t('remoteNodes.loadFailed'));
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setForm({ ...emptyForm });
    setEditing(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      token: form.token,
      profile: form.profile.trim() || undefined,
      enabled: form.enabled,
    };
    const result = editing
      ? await apiPut<ApiResult<RemoteNode>>(`/remote-nodes/${encodeURIComponent(form.id)}`, payload)
      : await apiPost<ApiResult<RemoteNode>>('/remote-nodes', payload);
    if (result.success) {
      setNotice(editing ? t('remoteNodes.updated') : t('remoteNodes.added'));
      resetForm();
      await load();
    } else {
      setError(result.message ?? t('remoteNodes.saveFailed'));
    }
  };

  const startEdit = (node: RemoteNode) => {
    setEditing(true);
    setError('');
    setNotice('');
    setForm({
      id: node.id,
      name: node.name,
      baseUrl: node.baseUrl,
      token: '',
      profile: node.profile ?? '',
      enabled: node.enabled !== false,
    });
  };

  const remove = async (node: RemoteNode) => {
    if (!window.confirm(t('remoteNodes.confirmRemove', { name: node.name }))) return;
    const result = await apiDelete<ApiResult<void>>(`/remote-nodes/${encodeURIComponent(node.id)}`);
    if (result.success) {
      setNotice(t('remoteNodes.removed'));
      await load();
    } else {
      setError(result.message ?? t('remoteNodes.deleteFailed'));
    }
  };

  const syncFromScheduler = async () => {
    setDiscovering(true);
    setError('');
    setNotice('');
    const result = await apiGet<ApiResult<DiscoveredNode[]>>('/remote-nodes/discover');
    if (result.success && result.data) {
      setDiscovered(result.data);
      setSelectedIds(result.data.filter((n) => !n.alreadyManaged).map((n) => n.id));
    } else {
      setError(result.message ?? t('remoteNodes.syncFailed'));
    }
    setDiscovering(false);
  };

  const importSelected = async () => {
    setError('');
    const result = await apiPost<ApiResult<RemoteNode[]>>('/remote-nodes/import', {
      ids: selectedIds,
      nodes: discovered ?? [],
    });
    if (result.success) {
      setNotice(t('remoteNodes.imported', { count: selectedIds.length }));
      setDiscovered(null);
      setSelectedIds([]);
      await load();
    } else {
      setError(result.message ?? t('remoteNodes.importFailed'));
    }
  };

  const discover = async (node: RemoteNode) => {
    setServersLoading((prev) => ({ ...prev, [node.id]: true }));
    setError('');
    const result = await apiGet<ApiResult<RemoteServer[]>>(`/remote-nodes/${encodeURIComponent(node.id)}/servers`);
    if (result.success && result.data) {
      setServers((prev) => ({ ...prev, [node.id]: result.data! }));
    } else {
      setError(result.message ?? t('remoteNodes.discoverFailed'));
    }
    setServersLoading((prev) => ({ ...prev, [node.id]: false }));
  };

  const toggle = async (node: RemoteNode, server: RemoteServer, enabled: boolean) => {
    const result = await apiPost<ApiResult<void>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(server.name)}/toggle`,
      { enabled },
    );
    if (result.success) await discover(node);
    else setError(result.message ?? t('remoteNodes.operationFailed'));
  };

  const removeServer = async (node: RemoteNode, server: RemoteServer) => {
    if (!window.confirm(t('remoteNodes.confirmRemoveServer', { name: server.name }))) return;
    const result = await apiDelete<ApiResult<void>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(server.name)}`,
    );
    if (result.success) await discover(node);
    else setError(result.message ?? t('remoteNodes.deleteFailed'));
  };

  const registerNode = async (node: RemoteNode) => {
    setError('');
    setNotice('');
    const result = await apiPost<ApiResult<any[]>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/register`,
    );
    if (result.success) {
      setNotice(t('remoteNodes.registered', { count: result.data?.length ?? 0, node: node.name }));
    } else {
      setError(result.message ?? t('remoteNodes.registerFailed'));
    }
  };

  const field = (key: keyof typeof form, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const inputClass =
    'w-full border border-[var(--hub-line)] bg-[var(--hub-surface)] rounded-md px-3 py-2 text-sm text-[var(--hub-ink)] placeholder:text-[var(--hub-ink-3)] focus:outline-none focus:border-[var(--hub-ink-2)]';
  const labelClass = 'block text-[var(--hub-ink-2)] text-sm font-bold mb-2';

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="hub-h1">{t('remoteNodes.title')}</h1>
        <p className="hub-sub mt-1">{t('remoteNodes.subtitle')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-500">
          {notice}
        </div>
      )}

      <section className="hub-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--hub-ink)]">{t('remoteNodes.syncTitle')}</h2>
            <p className="text-xs text-[var(--hub-ink-3)]">{t('remoteNodes.syncHint')}</p>
          </div>
          <button className="hub-btn" onClick={() => void syncFromScheduler()} disabled={discovering}>
            {discovering ? t('app.loading') : t('remoteNodes.syncButton')}
          </button>
        </div>
        {discovered && (
          <div className="space-y-3 border-t border-[var(--hub-line-2)] pt-3">
            {discovered.length === 0 && (
              <div className="text-sm text-[var(--hub-ink-3)]">{t('remoteNodes.noDiscovered')}</div>
            )}
            {discovered.map((node) => (
              <label key={node.id} className="flex items-start gap-3 text-sm text-[var(--hub-ink)]">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(node.id)}
                  disabled={node.alreadyManaged}
                  onChange={(e) => setSelectedIds((prev) =>
                    e.target.checked ? [...prev, node.id] : prev.filter((id) => id !== node.id))}
                />
                <span className="flex-1">
                  <span className="font-medium">{node.name}</span>
                  {node.alreadyManaged && (
                    <span className="ml-2 text-xs text-[var(--hub-ink-3)]">{t('remoteNodes.alreadyManaged')}</span>
                  )}
                  <span className="block text-xs text-[var(--hub-ink-3)]">
                    {node.host} · {node.baseUrl}
                  </span>
                </span>
                {node.profile && (
                  <span className="rounded-full border border-[var(--hub-line)] px-2 py-0.5 text-xs text-[var(--hub-ink-2)]">
                    {node.profile}
                  </span>
                )}
                {node.status && (
                  <span className="rounded-full border border-[var(--hub-line)] px-2 py-0.5 text-xs text-[var(--hub-ink-2)]">
                    {node.status}
                  </span>
                )}
              </label>
            ))}
            {discovered.some((n) => !n.alreadyManaged) && (
              <div className="flex items-center gap-2">
                <button className="hub-btn primary" onClick={() => void importSelected()} disabled={selectedIds.length === 0}>
                  {t('remoteNodes.importButton')}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <form onSubmit={submit} className="hub-card p-5 space-y-4">
        <h2 className="text-base font-semibold text-[var(--hub-ink)]">
          {editing ? t('remoteNodes.editTitle') : t('remoteNodes.addTitle')}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rn-id">ID</label>
            <input id="rn-id" className={inputClass} value={form.id} disabled={editing}
              onChange={(e) => field('id', e.target.value)} required />
          </div>
          <div>
            <label className={labelClass} htmlFor="rn-name">{t('remoteNodes.name')}</label>
            <input id="rn-name" className={inputClass} value={form.name}
              onChange={(e) => field('name', e.target.value)} required />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="rn-url">{t('remoteNodes.baseUrl')}</label>
            <input id="rn-url" className={inputClass} placeholder="http://host:3000/app/com.ictrek.mcphub"
              value={form.baseUrl} onChange={(e) => field('baseUrl', e.target.value)} required />
          </div>
          <div>
            <label className={labelClass} htmlFor="rn-token">{t('remoteNodes.token')}</label>
            <input id="rn-token" className={inputClass} type="password" value={form.token}
              placeholder={editing ? t('remoteNodes.tokenKeep') : ''}
              onChange={(e) => field('token', e.target.value)} required={!editing} />
          </div>
          <div>
            <label className={labelClass} htmlFor="rn-profile">{t('remoteNodes.profile')}</label>
            <input id="rn-profile" className={inputClass} placeholder="amd-cuda"
              value={form.profile} onChange={(e) => field('profile', e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--hub-ink)]">
          <input type="checkbox" checked={form.enabled}
            onChange={(e) => field('enabled', e.target.checked)} />
          {t('remoteNodes.enabled')}
        </label>
        <div className="flex gap-2">
          <button type="submit" className="hub-btn primary">{t('common.save')}</button>
          {editing && <button type="button" className="hub-btn" onClick={resetForm}>{t('common.cancel')}</button>}
        </div>
      </form>

      <div className="space-y-3">
        {loading && <div className="text-sm text-[var(--hub-ink-3)]">{t('app.loading')}</div>}
        {!loading && nodes.length === 0 && (
          <div className="text-sm text-[var(--hub-ink-3)]">{t('remoteNodes.empty')}</div>
        )}
        {nodes.map((node) => (
          <div key={node.id} className="hub-card p-5 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--hub-ink)]">{node.name}</span>
                  <span className="rounded-full border border-[var(--hub-line)] px-2 py-0.5 text-xs text-[var(--hub-ink-2)]">
                    {node.enabled === false ? t('remoteNodes.disabled') : t('remoteNodes.online')}
                  </span>
                  {node.profile && (
                    <span className="rounded-full border border-[var(--hub-line)] px-2 py-0.5 text-xs text-[var(--hub-ink-2)]">
                      {node.profile}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-[var(--hub-ink-3)]">{node.id} · {node.baseUrl}</div>
                <div className="mt-1 text-xs text-[var(--hub-ink-3)]">
                  {node.hasToken ? t('remoteNodes.tokenConfigured') : t('remoteNodes.noToken')}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="hub-btn" onClick={() => void discover(node)}>
                  {t('remoteNodes.discover')}
                </button>
                <button className="hub-btn primary" onClick={() => void registerNode(node)}>
                  {t('remoteNodes.registerLocal')}
                </button>
                <button className="hub-btn" onClick={() => startEdit(node)}>{t('common.edit')}</button>
                <button className="hub-btn" onClick={() => void remove(node)}>{t('common.delete')}</button>
              </div>
            </div>

            {servers[node.id] && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--hub-line)] text-left text-[var(--hub-ink-2)]">
                      <th className="py-2 pr-4">{t('remoteNodes.serverName')}</th>
                      <th className="py-2 pr-4">{t('remoteNodes.visibility')}</th>
                      <th className="py-2 pr-4">{t('remoteNodes.status')}</th>
                      <th className="py-2 text-right">{t('remoteNodes.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers[node.id].length === 0 && (
                      <tr><td colSpan={4} className="py-2 text-center text-[var(--hub-ink-3)]">{t('remoteNodes.noServers')}</td></tr>
                    )}
                    {servers[node.id].map((server) => (
                      <tr key={server.name} className="border-b border-[var(--hub-line-2)]">
                        <td className="py-2 pr-4">
                          <div className="font-medium text-[var(--hub-ink)]">{server.name}</div>
                          {server.description && <div className="text-xs text-[var(--hub-ink-3)]">{server.description}</div>}
                        </td>
                        <td className="py-2 pr-4 text-[var(--hub-ink-2)]">{server.visibility ?? '-'}</td>
                        <td className="py-2 pr-4 text-[var(--hub-ink-2)]">{server.status ?? '-'}</td>
                        <td className="py-2 text-right space-x-2">
                          <button className="hub-btn"
                            onClick={() => void toggle(node, server, server.enabled === false)}>
                            {server.enabled === false ? t('remoteNodes.start') : t('remoteNodes.stop')}
                          </button>
                          <button className="hub-btn" onClick={() => void removeServer(node, server)}>
                            {t('common.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {serversLoading[node.id] && <div className="mt-2 text-xs text-[var(--hub-ink-3)]">{t('app.loading')}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default RemoteNodesPage;
