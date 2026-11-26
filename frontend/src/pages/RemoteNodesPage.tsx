import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/fetchInterceptor';
import { useAuth } from '@/contexts/AuthContext';

interface RemoteNode {
  id: string;
  name: string;
  schedulerNodeId?: string;
  address?: string;
  hostname?: string;
  arch?: string;
  gpuModel?: string;
  profile?: string;
  status?: string;
  lastCheckedAt?: string;
  enabled?: boolean;
}

interface DiscoveredNode {
  id: string;
  name: string;
  address?: string;
  hostname?: string;
  arch?: string;
  gpuModel?: string;
  profile?: string;
  status?: string;
  lastCheckedAt?: string;
  alreadyManaged: boolean;
}

interface RemoteServer {
  id: string;
  serverName: string;
  schedulerNodeId: string;
  address: string;
  profile?: string;
  upstreamName?: string;
  reachable?: boolean;
  lastCheckedAt?: string;
  lastError?: string;
  enabled?: boolean;
  status?: string;
}

interface NodeLinkServer {
  name: string;
  type?: string;
  status: string;
  mcpPath?: string;
  attached: boolean;
}

interface DeployedServer {
  name: string;
  url: string | null;
  enabled: boolean;
  deploymentId: string | null;
}

interface ApiResult<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const emptyForm = {
  id: '', name: '', address: '', hostname: '', arch: '', gpuModel: '', profile: '', enabled: true,
  dataPlaneToken: '',
};

const emptyDeployForm = { name: '', image: '', port: '3000', public: false };

const RemoteNodesPage: React.FC = () => {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [nodes, setNodes] = useState<RemoteNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ ...emptyForm });
  const [editing, setEditing] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredNode[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [servers, setServers] = useState<Record<string, RemoteServer[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [peerServers, setPeerServers] = useState<Record<string, NodeLinkServer[]>>({});
  const [peerErrors, setPeerErrors] = useState<Record<string, string>>({});
  const [peerLoading, setPeerLoading] = useState<Record<string, boolean>>({});
  const [pairing, setPairing] = useState<Record<string, boolean>>({});
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [deployed, setDeployed] = useState<Record<string, DeployedServer[]>>({});
  const [deployForm, setDeployForm] = useState<Record<string, { name: string; image: string; port: string; public: boolean }>>({});
  const [deploying, setDeploying] = useState<Record<string, boolean>>({});
  const [lifecycleLoading, setLifecycleLoading] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await apiGet<ApiResult<RemoteNode[]>>('/remote-nodes');
    if (result.success && result.data) setNodes(result.data);
    else setError(result.message ?? t('remoteNodes.loadFailed'));
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (auth.user?.isAdmin) void load();
  }, [auth.user?.isAdmin, load]);

  const loadServers = useCallback(async (nodeId: string) => {
    const result = await apiGet<ApiResult<RemoteServer[]>>(`/remote-nodes/${encodeURIComponent(nodeId)}/servers`);
    if (result.success && result.data) {
      setServers((current) => ({ ...current, [nodeId]: result.data! }));
    } else {
      setError(result.message ?? t('remoteNodes.servicesLoadFailed'));
    }
  }, [t]);

  const loadPeerServers = useCallback(async (nodeId: string) => {
    setPeerLoading((current) => ({ ...current, [nodeId]: true }));
    const result = await apiGet<ApiResult<NodeLinkServer[]>>(
      `/node-links/${encodeURIComponent(nodeId)}/servers`,
    );
    if (result.success && result.data) {
      setPeerServers((current) => ({ ...current, [nodeId]: result.data! }));
      setPeerErrors((current) => ({ ...current, [nodeId]: '' }));
    } else {
      const message = result.message ?? t('remoteNodes.peerLoadFailed');
      setPeerErrors((current) => ({ ...current, [nodeId]: message }));
      setError(message);
    }
    setPeerLoading((current) => ({ ...current, [nodeId]: false }));
  }, [t]);

  const loadCredentialStatus = useCallback(async (nodeId: string) => {
    const result = await apiGet<ApiResult<{ configured: boolean; source: string | null }>>(
      `/node-links/${encodeURIComponent(nodeId)}/credential`,
    );
    setCredentialConfigured(Boolean(result.success && result.data?.configured));
  }, []);

  const loadDeployed = useCallback(async (nodeId: string) => {
    const result = await apiGet<ApiResult<DeployedServer[]>>(
      `/remote-nodes/${encodeURIComponent(nodeId)}/deployed`,
    );
    if (result.success && result.data) {
      setDeployed((current) => ({ ...current, [nodeId]: result.data! }));
    }
  }, []);

  const toggleExpanded = (nodeId: string) => {
    const next = !expanded[nodeId];
    setExpanded((current) => ({ ...current, [nodeId]: next }));
    if (next) {
      void loadServers(nodeId);
      void loadPeerServers(nodeId);
      void loadDeployed(nodeId);
    }
  };

  const deployService = async (node: RemoteNode) => {
    const entry = deployForm[node.id] ?? { ...emptyDeployForm };
    if (!entry.name.trim() || !entry.image.trim()) {
      setError(t('remoteNodes.deployFieldsRequired'));
      return;
    }
    setDeploying((current) => ({ ...current, [node.id]: true }));
    setError('');
    setNotice('');
    const result = await apiPost<ApiResult<{ name: string; endpoint: string; url: string }>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/deploy`,
      {
        name: entry.name.trim(),
        image: entry.image.trim(),
        containerPort: Number(entry.port) || 3000,
        ...(entry.public ? { visibility: 'public' } : {}),
      },
    );
    if (result.success) {
      setNotice(t('remoteNodes.deploySuccess', { endpoint: result.data?.endpoint ?? '' }));
      setDeployForm((current) => ({ ...current, [node.id]: { ...emptyDeployForm } }));
      await loadDeployed(node.id);
    } else {
      setError(result.message ?? t('remoteNodes.deployFailed'));
    }
    setDeploying((current) => ({ ...current, [node.id]: false }));
  };

  const lifecycleAction = async (
    node: RemoteNode,
    server: DeployedServer,
    action: 'stop' | 'start' | 'undeploy',
  ) => {
    if (action === 'undeploy' && !window.confirm(t('remoteNodes.confirmUndeploy', { name: server.name }))) return;
    const key = `${node.id}:${server.name}`;
    setLifecycleLoading((current) => ({ ...current, [key]: action }));
    setError('');
    setNotice('');
    const result = await apiPost<ApiResult<unknown>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(server.name)}/${action}`,
      {},
    );
    if (result.success) {
      setNotice(t(`remoteNodes.${action}Notice`));
      await loadDeployed(node.id);
    } else {
      setError(result.message ?? t('remoteNodes.lifecycleFailed'));
    }
    setLifecycleLoading((current) => ({ ...current, [key]: '' }));
  };

  if (!auth.user?.isAdmin) {
    return <div className="hub-card p-6 text-center" style={{ color: 'var(--hub-err)' }}>{t('users.adminRequired')}</div>;
  }

  const resetForm = () => {
    setForm({ ...emptyForm });
    setCredentialConfigured(false);
    setEditing(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!form.address.trim() && !form.hostname.trim()) {
      setError(t('remoteNodes.addressRequired'));
      return;
    }
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      address: form.address.trim() || undefined,
      hostname: form.hostname.trim() || undefined,
      arch: form.arch.trim() || undefined,
      gpuModel: form.gpuModel.trim() || undefined,
      profile: form.profile.trim() || undefined,
      enabled: form.enabled,
    };
    const result = editing
      ? await apiPut<ApiResult<RemoteNode>>(`/remote-nodes/${encodeURIComponent(form.id)}`, payload)
      : await apiPost<ApiResult<RemoteNode>>('/remote-nodes', payload);
    if (result.success) {
      setNotice(editing ? t('remoteNodes.updated') : t('remoteNodes.added'));
      const savedId = form.id.trim() || result.data?.id;
      const token = form.dataPlaneToken.trim();
      if (token && savedId) {
        const saved = await apiPut<ApiResult<unknown>>(
          `/node-links/${encodeURIComponent(savedId)}/credential`,
          { token },
        );
        if (saved.success) {
          setCredentialConfigured(true);
          setNotice(t('remoteNodes.credentialSaved'));
        } else {
          setError(saved.message ?? t('remoteNodes.credentialSaveFailed'));
        }
      }
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
      address: node.address ?? '',
      hostname: node.hostname ?? '',
      arch: node.arch ?? '',
      gpuModel: node.gpuModel ?? '',
      profile: node.profile ?? '',
      enabled: node.enabled !== false,
      dataPlaneToken: '',
    });
    void loadCredentialStatus(node.id);
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
      setSelectedIds(result.data.filter((node) => !node.alreadyManaged).map((node) => node.id));
    } else {
      setError(result.message ?? t('remoteNodes.syncFailed'));
    }
    setDiscovering(false);
  };

  const importSelected = async () => {
    if (!discovered || selectedIds.length === 0) return;
    setError('');
    const result = await apiPost<ApiResult<RemoteNode[]>>('/remote-nodes/import', {
      ids: selectedIds,
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

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const toggleServer = async (node: RemoteNode, server: RemoteServer, enabled: boolean) => {
    if (!enabled && !window.confirm(t('remoteNodes.confirmDisconnect', { name: server.serverName }))) return;
    setError('');
    setNotice('');
    const result = await apiPost<ApiResult<unknown>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(server.serverName)}/toggle`,
      { enabled },
    );
    if (result.success) {
      setNotice(enabled ? t('remoteNodes.serviceConnected') : t('remoteNodes.serviceDisconnected'));
      await loadServers(node.id);
    } else {
      setError(result.message ?? t('remoteNodes.serviceToggleFailed'));
    }
  };

  const removeServer = async (node: RemoteNode, server: RemoteServer) => {
    if (!window.confirm(t('remoteNodes.confirmRemoveService', { name: server.serverName }))) return;
    setError('');
    setNotice('');
    const result = await apiDelete<ApiResult<void>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(server.serverName)}`,
    );
    if (result.success) {
      setNotice(t('remoteNodes.serviceRemoved'));
      await loadServers(node.id);
    } else {
      setError(result.message ?? t('remoteNodes.serviceDeleteFailed'));
    }
  };

  const togglePeerServer = async (node: RemoteNode, peer: NodeLinkServer) => {
    if (peer.attached && !window.confirm(t('remoteNodes.confirmDetach', { name: peer.name }))) return;
    setError('');
    setNotice('');
    const action = peer.attached ? 'detach' : 'attach';
    const result = await apiPost<ApiResult<{ name: string; attached: boolean }>>(
      `/node-links/${encodeURIComponent(node.id)}/servers/${encodeURIComponent(peer.name)}/${action}`,
    );
    if (result.success) {
      setNotice(peer.attached ? t('remoteNodes.detachedNotice') : t('remoteNodes.attachedNotice'));
      await Promise.all([loadPeerServers(node.id), loadServers(node.id)]);
    } else {
      setError(result.message ?? t(peer.attached ? 'remoteNodes.detachFailed' : 'remoteNodes.attachFailed'));
    }
  };

  // §9 自动配对: one click — the hub mints/exchanges the pairing code with the
  // peer and stores the certificate + control token; no manual provisioning.
  const pairNode = async (node: RemoteNode) => {
    setPairing((current) => ({ ...current, [node.id]: true }));
    setError('');
    setNotice('');
    const result = await apiPost<ApiResult<{ paired: boolean }>>(
      `/remote-nodes/${encodeURIComponent(node.id)}/pair`,
      {},
    );
    if (result.success) {
      setNotice(t('remoteNodes.paired'));
      await loadPeerServers(node.id);
    } else {
      setError(result.message ?? t('remoteNodes.pairFailed'));
    }
    setPairing((current) => ({ ...current, [node.id]: false }));
  };

  const field = (key: keyof typeof form, label: string, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-[12px]">
      <span>{label}</span>
      <input
        className="hub-input"
        value={form[key] as string}
        placeholder={placeholder}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
      />
    </label>
  );

  return (
    <div>
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="hub-h1">{t('pages.remoteNodes.title')}</h1>
          <p className="hub-sub">{t('remoteNodes.subtitle')}</p>
        </div>
        <button className="hub-btn" onClick={() => void syncFromScheduler()} disabled={discovering}>
          {discovering ? t('remoteNodes.discovering') : t('remoteNodes.discover')}
        </button>
      </div>

      {error && <div className="hub-card mb-4 p-3 text-[13px]" style={{ color: 'var(--hub-err)' }}>{error}</div>}
      {notice && <div className="hub-card mb-4 p-3 text-[13px]">{notice}</div>}

      {discovered && (
        <section className="hub-card mb-6 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="hub-h2">{t('remoteNodes.discovered')}</h2>
            <button className="hub-btn primary" onClick={() => void importSelected()} disabled={selectedIds.length === 0}>
              {t('remoteNodes.importSelected', { count: selectedIds.length })}
            </button>
          </div>
          {discovered.length === 0 ? (
            <p className="hub-sub">{t('remoteNodes.discoveredEmpty')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {discovered.map((node) => (
                <label key={node.id} className="flex items-center gap-3 text-[13px]">
                  <input
                    type="checkbox"
                    checked={node.alreadyManaged || selectedIds.includes(node.id)}
                    disabled={node.alreadyManaged}
                    onChange={() => toggleSelected(node.id)}
                  />
                  <span className="font-medium">{node.name}</span>
                  <span className="hub-sub">{node.address ?? node.hostname}</span>
                  {node.profile && <span className="hub-badge">{node.profile}</span>}
                  {node.alreadyManaged && <span className="hub-sub">{t('remoteNodes.alreadyManaged')}</span>}
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="hub-card mb-6 p-4">
        <h2 className="hub-h2 mb-3">{editing ? t('remoteNodes.editTitle') : t('remoteNodes.addTitle')}</h2>
        <form className="grid grid-cols-1 md:grid-cols-2 gap-3" onSubmit={(event) => void submit(event)}>
          {field('id', t('remoteNodes.id'), t('remoteNodes.idHint'))}
          {field('name', t('remoteNodes.name'))}
          {field('address', t('remoteNodes.address'), '10.0.0.1')}
          {field('hostname', t('remoteNodes.hostname'))}
          {field('arch', t('remoteNodes.arch'))}
          {field('gpuModel', t('remoteNodes.gpuModel'))}
          {field('profile', t('remoteNodes.profile'))}
          <label className="flex flex-col gap-1 text-[12px] md:col-span-2">
            <span>{t('remoteNodes.dataPlaneToken')}</span>
            <input
              className="hub-input"
              type="password"
              autoComplete="new-password"
              value={form.dataPlaneToken}
              placeholder={credentialConfigured ? t('remoteNodes.credentialConfigured') : t('remoteNodes.credentialPlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, dataPlaneToken: event.target.value }))}
            />
            <span className="hub-sub">{t('remoteNodes.dataPlaneTokenHint')}</span>
            <span className="hub-sub">{t('remoteNodes.credentialScopeHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-[12px] self-end">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
            {t('remoteNodes.enabled')}
          </label>
          <div className="md:col-span-2 flex gap-2">
            <button className="hub-btn primary" type="submit">{t('common.save')}</button>
            {editing && <button className="hub-btn" type="button" onClick={resetForm}>{t('common.cancel')}</button>}
          </div>
        </form>
      </section>

      {loading ? (
        <p className="hub-sub">{t('common.loading')}</p>
      ) : nodes.length === 0 ? (
        <p className="hub-sub">{t('remoteNodes.empty')}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {nodes.map((node) => (
            <section key={node.id} className="hub-card p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="font-medium">{node.name}</div>
                  <div className="hub-sub">{node.address ?? node.hostname ?? node.id}</div>
                </div>
                <div className="flex gap-2">
                  <button className="hub-btn sm" onClick={() => startEdit(node)}>{t('common.edit')}</button>
                  <button className="hub-btn sm" onClick={() => void remove(node)}>{t('common.delete')}</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[12px]">
                {node.profile && <span className="hub-badge">{node.profile}</span>}
                {node.arch && <span className="hub-badge">{node.arch}</span>}
                {node.gpuModel && <span className="hub-badge">{node.gpuModel}</span>}
                {node.status && <span className="hub-badge">{node.status}</span>}
                {node.enabled === false && <span className="hub-badge">{t('remoteNodes.disabled')}</span>}
              </div>
              {node.lastCheckedAt && <div className="hub-sub mt-2">{t('remoteNodes.lastCheckedAt')}: {node.lastCheckedAt}</div>}

              <button className="hub-btn sm mt-3" onClick={() => toggleExpanded(node.id)}>
                {expanded[node.id] ? t('remoteNodes.hideServices') : t('remoteNodes.manageServices')}
              </button>
              {expanded[node.id] && (
                <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--hub-border)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-medium">{t('remoteNodes.peerServices')}</h3>
                    <div className="flex gap-2">
                      <button
                        className="hub-btn primary sm"
                        disabled={pairing[node.id]}
                        onClick={() => void pairNode(node)}
                      >
                        {pairing[node.id] ? t('common.loading') : t('remoteNodes.pair')}
                      </button>
                      <button className="hub-btn sm" onClick={() => void loadPeerServers(node.id)}>
                        {t('remoteNodes.peerRefresh')}
                      </button>
                    </div>
                  </div>
                  {peerErrors[node.id] ? (
                    <p className="text-[12px] mb-3" style={{ color: 'var(--hub-err)' }}>{peerErrors[node.id]}</p>
                  ) : peerLoading[node.id] ? (
                    <p className="hub-sub mb-3">{t('common.loading')}</p>
                  ) : (peerServers[node.id] ?? []).length === 0 ? (
                    <p className="hub-sub mb-3">{t('remoteNodes.peerServicesEmpty')}</p>
                  ) : (
                    <div className="flex flex-col gap-2 mb-4">
                      {(peerServers[node.id] ?? []).map((peer) => (
                        <div key={peer.name} className="flex items-center justify-between gap-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{peer.name}</div>
                            <div className="hub-sub truncate" title={peer.mcpPath}>{peer.mcpPath ?? '-'}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {peer.type && <span className="hub-badge">{peer.type}</span>}
                              {peer.status && <span className="hub-badge">{peer.status}</span>}
                              <span className="hub-badge">
                                {peer.attached ? t('remoteNodes.attached') : t('remoteNodes.notAttached')}
                              </span>
                            </div>
                          </div>
                          <button className="hub-btn sm flex-shrink-0" onClick={() => void togglePeerServer(node, peer)}>
                            {peer.attached ? t('remoteNodes.detach') : t('remoteNodes.attach')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <h3 className="text-[13px] font-medium mb-2 mt-4">{t('remoteNodes.deployTitle')}</h3>
                  <p className="hub-sub mb-2">{t('remoteNodes.deployHint')}</p>
                  <div className="flex flex-wrap items-end gap-2 mb-3">
                    <input
                      className="hub-input w-44"
                      placeholder={t('remoteNodes.deployName')}
                      value={(deployForm[node.id] ?? emptyDeployForm).name}
                      onChange={(event) => setDeployForm((current) => ({
                        ...current,
                        [node.id]: { ...(current[node.id] ?? emptyDeployForm), name: event.target.value },
                      }))}
                    />
                    <input
                      className="hub-input flex-1 min-w-[220px]"
                      placeholder={t('remoteNodes.deployImage')}
                      value={(deployForm[node.id] ?? emptyDeployForm).image}
                      onChange={(event) => setDeployForm((current) => ({
                        ...current,
                        [node.id]: { ...(current[node.id] ?? emptyDeployForm), image: event.target.value },
                      }))}
                    />
                    <input
                      className="hub-input w-20"
                      value={(deployForm[node.id] ?? emptyDeployForm).port}
                      onChange={(event) => setDeployForm((current) => ({
                        ...current,
                        [node.id]: { ...(current[node.id] ?? emptyDeployForm), port: event.target.value },
                      }))}
                    />
                    <label className="flex items-center gap-1 text-[12px]">
                      <input
                        type="checkbox"
                        checked={(deployForm[node.id] ?? emptyDeployForm).public}
                        onChange={(event) => setDeployForm((current) => ({
                          ...current,
                          [node.id]: { ...(current[node.id] ?? emptyDeployForm), public: event.target.checked },
                        }))}
                      />
                      {t('remoteNodes.deployPublic')}
                    </label>
                    <button
                      className="hub-btn primary sm"
                      disabled={deploying[node.id]}
                      onClick={() => void deployService(node)}
                    >
                      {deploying[node.id] ? t('remoteNodes.deploying') : t('remoteNodes.deploy')}
                    </button>
                  </div>
                  {(deployed[node.id] ?? []).length === 0 ? (
                    <p className="hub-sub mb-3">{t('remoteNodes.deployedEmpty')}</p>
                  ) : (
                    <div className="flex flex-col gap-2 mb-3">
                      {(deployed[node.id] ?? []).map((server) => (
                        <div key={server.name} className="flex items-center justify-between gap-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{server.name}</div>
                            <div className="hub-sub truncate" title={server.url ?? ''}>{server.url ?? '-'}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              <span className="hub-badge">
                                {server.enabled ? t('remoteNodes.deployedEnabled') : t('remoteNodes.deployedPaused')}
                              </span>
                            </div>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              className="hub-btn sm"
                              disabled={lifecycleLoading[`${node.id}:${server.name}`] === 'stop' || lifecycleLoading[`${node.id}:${server.name}`] === 'start'}
                              onClick={() => void lifecycleAction(node, server, server.enabled ? 'stop' : 'start')}
                            >
                              {server.enabled ? t('remoteNodes.pause') : t('remoteNodes.resume')}
                            </button>
                            <button
                              className="hub-btn sm"
                              disabled={lifecycleLoading[`${node.id}:${server.name}`] === 'undeploy'}
                              onClick={() => void lifecycleAction(node, server, 'undeploy')}
                            >
                              {t('remoteNodes.undeploy')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <h3 className="text-[13px] font-medium mb-2">{t('remoteNodes.services')}</h3>
                  {(servers[node.id] ?? []).length === 0 ? (
                    <p className="hub-sub">{t('remoteNodes.servicesEmpty')}</p>
                  ) : (
                    <div className="flex flex-col gap-2 mb-3">
                      {(servers[node.id] ?? []).map((server) => (
                        <div key={server.id} className="flex items-center justify-between gap-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{server.serverName}</div>
                            <div className="hub-sub truncate" title={server.address}>{server.address}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {server.upstreamName && <span className="hub-badge">{server.upstreamName}</span>}
                              {server.status && <span className="hub-badge">{server.status}</span>}
                              <span className="hub-badge">
                                {server.reachable === false ? t('remoteNodes.serviceUnreachable') : t('remoteNodes.serviceReachable')}
                              </span>
                            </div>
                            {server.lastError && <div style={{ color: 'var(--hub-err)' }}>{server.lastError}</div>}
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              className="hub-btn sm"
                              onClick={() => void toggleServer(node, server, !server.enabled)}
                            >
                              {server.enabled ? t('remoteNodes.disconnect') : t('remoteNodes.connect')}
                            </button>
                            <button className="hub-btn sm" onClick={() => void removeServer(node, server)}>
                              {t('common.delete')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default RemoteNodesPage;
