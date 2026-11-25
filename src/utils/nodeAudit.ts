import { logger } from './logger.js';

export interface NodeAuditEntry {
  peer: string;
  action: string;
  server: string;
  ok: boolean;
  code?: string | null;
  /** sha256 of the client cert (first 16 hex chars); null on plain HTTP (§A-2). */
  certFingerprint?: string | null;
}

/**
 * Run-log level audit for node operations. Only metadata is serialized:
 * tokens, full definitions and env values must never reach this line.
 */
export const auditNodeAction = ({
  peer,
  action,
  server,
  ok,
  code,
  certFingerprint,
}: NodeAuditEntry): void => {
  logger.info(
    '[node-ops] audit',
    JSON.stringify({
      peer,
      action,
      server,
      ok,
      code: code ?? null,
      certFingerprint: certFingerprint ?? null,
      ts: new Date().toISOString(),
    }),
  );
};
