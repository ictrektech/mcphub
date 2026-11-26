// §P2 Deploy MCP servers onto V-Scheduler compute nodes (image-studio pattern).
//
// MCPHub composes the deployment request and lets the scheduler do the heavy
// lifting: allocate a host port, generate channel credentials, SSH to the node
// and run the container. When the deployment reports `running`, its `endpoint`
// (node IP + allocated port) is registered in MCPHub as a streamable-http
// upstream, so users get a tool that actually executes on the node's own
// profile compute. Nodes carry no MCPHub instance — no pairing, no inter-hub
// trust; auth is the deploy-time channel credential.
//
// Scheduler-side access control: an app may only deploy images from permitted
// repositories onto permitted targets. `ensureDeploymentAccess` keeps the
// permit in sync (GET-merge-PUT) through the scheduler's own admin API — no
// external cooperation is required.

import { logger } from '../utils/logger.js';
import { RemoteNodeError, SCHEDULER_URL } from './remoteNodeService.js';

export interface DeploymentTarget {
  kind: 'ssh' | 'cluster';
  id: string;
  profile: string;
}

export interface SchedulerDeploymentView {
  id: string;
  app_id: string;
  state: string;
  endpoint: string | null;
  host: string;
  host_port: number;
  profile: string;
  target_id: string;
  image: string;
  last_error?: string | null;
}

export interface DeployInput {
  appId: string;
  requestKey: string;
  target: DeploymentTarget;
  image: string;
  containerPort: number;
  hostPort?: number;
}

const POLL_INTERVAL_MS = Math.max(
  200,
  Number(process.env.MCP_NODE_DEPLOY_POLL_MS || 3000),
);
const POLL_TIMEOUT_MS = Math.max(
  POLL_INTERVAL_MS * 2,
  Number(process.env.MCP_NODE_DEPLOY_TIMEOUT_MS || 120_000),
);

const schedulerFetch = async (
  userToken: string,
  path: string,
  init?: RequestInit,
): Promise<any> => {
  let response: Response;
  try {
    response = await fetch(`${SCHEDULER_URL}/scheduler/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new RemoteNodeError('V-Scheduler unreachable', 502);
  }
  const payload: any = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.msg || `HTTP ${response.status}`;
    throw Object.assign(new RemoteNodeError(
      `V-Scheduler deployment API failed: ${message}`,
      response.status,
    ), { status: response.status });
  }
  return payload?.data;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ensures the app is permitted to deploy `image`'s repository onto `target`.
 * GET-merge-PUT through the scheduler's access API; a missing permit record is
 * treated as an empty one. */
export const ensureDeploymentAccess = async (
  userToken: string,
  appId: string,
  target: DeploymentTarget,
  repository: string,
): Promise<void> => {
  let current: { targets?: Array<Partial<DeploymentTarget>>; repositories?: string[] } =
    { targets: [], repositories: [] };
  try {
    current = (await schedulerFetch(userToken, `/backend-deployment-access/${appId}`)) ?? current;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  const targets = (current.targets ?? []).map((row) => ({
    kind: String(row.kind),
    id: String(row.id),
    profile: String(row.profile),
  }));
  const repositories = [...(current.repositories ?? [])];
  const targetKnown = targets.some((row) => row.kind === target.kind && row.id === target.id);
  const repositoryKnown = repositories.includes(repository);
  if (targetKnown && repositoryKnown) return;
  await schedulerFetch(userToken, `/backend-deployment-access/${appId}`, {
    method: 'PUT',
    body: JSON.stringify({
      targets: targetKnown ? targets : [...targets, target],
      repositories: repositoryKnown ? repositories : [...repositories, repository],
    }),
  });
  logger.info('[deploy] deployment access updated', { appId, target: target.id, repository });
};

/** Creates the deployment and polls until it reaches a terminal state.
 * Resolves with the running view (endpoint included) or throws. The request is
 * idempotent per `requestKey`: re-sending the same payload returns the
 * existing deployment instead of redeploying. */
export const deployToScheduler = async (
  userToken: string,
  input: DeployInput,
): Promise<SchedulerDeploymentView> => {
  const created = await schedulerFetch(userToken, '/backend-deployments', {
    method: 'POST',
    body: JSON.stringify({
      app_id: input.appId,
      request_key: input.requestKey,
      target: input.target,
      image: input.image,
      container_port: input.containerPort,
      ...(input.hostPort ? { host_port: input.hostPort } : {}),
    }),
  });
  const id: string | undefined = created?.id;
  if (!id) throw new RemoteNodeError('V-Scheduler did not return a deployment id', 502);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let view: SchedulerDeploymentView | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    view = await schedulerFetch(userToken, `/backend-deployments/${id}`);
    const state = String(view?.state ?? '');
    if (state === 'running' || state === 'error' || state === 'failed' || state === 'removed') break;
  }
  if (!view) {
    throw new RemoteNodeError('Deployment did not reach a terminal state in time', 504);
  }
  if (view.state !== 'running') {
    throw new RemoteNodeError(
      `Deployment state '${view.state}'${view.last_error ? `: ${view.last_error}` : ''}`,
      502,
    );
  }
  logger.info('[deploy] deployment running', {
    id: view.id,
    endpoint: view.endpoint,
    node: view.target_id,
    profile: view.profile,
  });
  return view;
};

/** Repository part of an image reference: everything before the last `:` when
 * it appears after the last `/` (i.e. the tag), otherwise the whole reference. */
export const imageRepositoryOf = (image: string): string => {
  const lastColon = image.lastIndexOf(':');
  const lastSlash = image.lastIndexOf('/');
  return lastColon > lastSlash ? image.slice(0, lastColon) : image;
};

/** Lifecycle: start/stop the container behind a deployment. The scheduler
 * transitions state asynchronously; the returned view reflects the state at
 * call time (callers may poll or simply toggle the local upstream). */
export const setDeploymentState = async (
  userToken: string,
  deploymentId: string,
  action: 'start' | 'stop',
): Promise<SchedulerDeploymentView> => {
  const view = await schedulerFetch(userToken, `/backend-deployments/${deploymentId}/${action}`, {
    method: 'POST',
  });
  logger.info('[deploy] deployment state change', { deploymentId, action, state: view?.state });
  return view;
};

/** Lifecycle: remove the deployment entirely (container gone, record kept as
 * `removed`). The caller is responsible for dropping the local server entry. */
export const removeDeployment = async (userToken: string, deploymentId: string): Promise<void> => {
  await schedulerFetch(userToken, `/backend-deployments/${deploymentId}`, { method: 'DELETE' });
  logger.info('[deploy] deployment removed', { deploymentId });
};
