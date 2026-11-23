// Shared integration token for cross-node MCPHub management. Every MCPHub
// instance built from the same release accepts this token, so adding a new
// node requires zero manual token configuration. Override via environment
// variable only when a deployment needs an explicit secret.
export const DEFAULT_INTEGRATION_TOKEN = 'mcphub-cross-node-v1';
export const resolveIntegrationToken = (): string =>
  process.env.MCPHUB_INTEGRATION_TOKEN?.trim() || DEFAULT_INTEGRATION_TOKEN;
