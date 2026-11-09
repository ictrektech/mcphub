// VOS adaptation: stream logs with an authenticated fetch; never put platform tokens in URLs.
import { getVosSession, isVosMode } from './vosAuthService';
import { useEffect, useState } from 'react';
import { apiGet, apiDelete } from '../utils/fetchInterceptor';
import { getApiUrl } from '../utils/runtime';
import { getToken } from '../utils/interceptors';

export interface LogEntry {
  timestamp: number;
  type: 'info' | 'error' | 'warn' | 'debug';
  source: string;
  message: string;
  processId?: string;
}

// Fetch all logs
export const fetchLogs = async (): Promise<LogEntry[]> => {
  try {
    const response = await apiGet<{ success: boolean; data: LogEntry[]; error?: string }>('/logs');

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch logs');
    }

    return response.data;
  } catch (error) {
    console.error('Error fetching logs', { error });
    throw error;
  }
};

// Clear all logs
export const clearLogs = async (): Promise<void> => {
  try {
    const response = await apiDelete<{ success: boolean; error?: string }>('/logs');

    if (!response.success) {
      throw new Error(response.error || 'Failed to clear logs');
    }
  } catch (error) {
    console.error('Error clearing logs', { error });
    throw error;
  }
};

/**
 * Singleton SSE connection manager.  Maintains a single EventSource shared
 * across all subscribers so that multiple components (e.g. the Logs page and
 * the embedding-sync alert listener) reuse one HTTP connection.
 */
class LogStreamManager {
  private eventSource: EventSource | null = null;
  private vosStream: AbortController | null = null;
  private subscribers = new Set<(event: MessageEvent) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openAttempts = 0;

  /** Subscribe to incoming SSE messages.  Returns an unsubscribe callback. */
  subscribe(callback: (event: MessageEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.subscribers.size === 1) {
      // Reset attempts when first subscriber added
      this.openAttempts = 0;
      this.openEventSource();
    }
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.close();
      }
    };
  }

  private openEventSource() {
    this.closeEventSource();
    if (isVosMode()) { void this.openVosStream(); return; }
    const token = getToken();

    if (!token) {
      console.warn('[LogStreamManager] No token available, scheduling reconnect...');
      this.scheduleReconnect();
      return;
    }

    try {
      const url = getApiUrl(`/logs/stream?token=${token}`);

      let redactedUrl = url;
      try {
        const parsedUrl = new URL(url);
        parsedUrl.search = '';
        redactedUrl = parsedUrl.toString();
      } catch {
        redactedUrl = url.split('?')[0] || url;
      }

      console.log('[LogStreamManager] Opening EventSource:', redactedUrl);
      this.eventSource = new EventSource(url);

      this.eventSource.onmessage = (event) => {
        this.subscribers.forEach((cb) => cb(event));
      };

      // Reset attempts only once the connection is actually established.
      // `new EventSource()` returns immediately and connects asynchronously, so
      // resetting here (rather than in onopen) cleared the counter on every
      // attempt and pinned the backoff below to its first step - a fixed 1s
      // retry loop whenever the stream kept dropping.
      this.eventSource.onopen = () => {
        this.openAttempts = 0;
        console.log('[LogStreamManager] EventSource opened successfully');
      };

      this.eventSource.onerror = () => {
        console.warn('[LogStreamManager] EventSource error, attempting reconnect...');
        this.closeEventSource();
        if (this.subscribers.size > 0) {
          this.scheduleReconnect();
        }
      };
    } catch (error) {
      console.error('[LogStreamManager] Failed to open EventSource:', error);
      this.closeEventSource();
      if (this.subscribers.size > 0) {
        this.scheduleReconnect();
      }
    }
  }

  private async openVosStream() {
    const controller = new AbortController();
    this.vosStream = controller;
    // Revalidate the platform identity periodically even when the SSE connection stays open.
    const timeout = setTimeout(() => controller.abort(), 240000);
    try {
      const session = await getVosSession();
      if (!session || controller.signal.aborted) return;
      const response = await fetch(getApiUrl('/logs/stream'), {
        headers: { 'x-vos-token': session.token.access_token }, signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Log stream unavailable');
      this.openAttempts = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) this.subscribers.forEach(callback => callback(new MessageEvent('message', { data })));
        }
      }
    } catch { /* Reconnect below without logging credentials or raw fetch errors. */ }
    finally {
      clearTimeout(timeout);
      if (this.vosStream === controller) {
        this.vosStream = null;
        if (this.subscribers.size > 0) this.scheduleReconnect();
      }
    }
  }

  private closeEventSource() {
    const stream = this.vosStream;
    this.vosStream = null;
    stream?.abort();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;

    // Exponential backoff: 1s, 2s, 4s, 8s max
    const delayMs = Math.min(1000 * Math.pow(2, this.openAttempts), 8000);
    this.openAttempts++;

    console.log(
      `[LogStreamManager] Scheduling reconnect in ${delayMs}ms (attempt ${this.openAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0) {
        this.openEventSource();
      }
    }, delayMs);
  }

  private close() {
    this.closeEventSource();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const logStreamManager = new LogStreamManager();

// Hook to use logs with SSE streaming
export const useLogs = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    // Fetch initial logs
    const loadInitialLogs = async () => {
      try {
        const initialLogs = await fetchLogs();
        if (mounted) {
          setLogs(initialLogs);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Failed to fetch logs'));
          setLoading(false);
        }
      }
    };

    loadInitialLogs();

    // Subscribe to SSE stream for new logs
    const handleMessage = (event: MessageEvent) => {
      if (!mounted) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'initial') {
          // Skip initial event, we already have logs from fetchLogs()
          return;
        }
        if (data.type === 'log') {
          setLogs((prevLogs) => [...prevLogs, data.log]);
        }
      } catch (err) {
        console.error('Error parsing SSE message', { err });
      }
    };

    const unsubscribe = logStreamManager.subscribe(handleMessage);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const clearAllLogs = async () => {
    try {
      await clearLogs();
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to clear logs'));
    }
  };

  return { logs, loading, error, clearLogs: clearAllLogs };
};
