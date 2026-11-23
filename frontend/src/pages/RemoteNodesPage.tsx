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

interface ApiResult<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const emptyForm = {
  id: '', name: '', address: '', hostname: '', arch: '', gpuModel: '', profile: '', enabled: true,
};

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

  if (!auth.user?.isAdmin) {
    return <div className="hub-card p-6 text-center" style={{ color: 'var(--hub-err)' }}>{t('users.adminRequired')}</div>;
  }

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
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default RemoteNodesPage;
