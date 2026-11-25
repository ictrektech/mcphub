import { logger } from './logger.js';

export interface NodeAuditEntry {
  peer: string;
  action: string;
  server: string;
  ok: boolean;
  code?: string | null;
}

/**
 * Run-log level audit for node operations. Only metadata is serialized:
 * tokens, full definitions and env values must never reach this line.
 */
export const auditNodeAction = ({ peer, action, server, ok, code }: NodeAuditEntry): void => {
  logger.info(
    '[node-ops] audit',
    JSON.stringify({
      peer,
      action,
      server,
      ok,
      code: code ?? null,
      ts: new Date().toISOString(),
    }),
  );
};
