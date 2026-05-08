/**
 * @module
 * WebSocket-based transport for server-mediated multi-user state synchronization.
 */
import type { SyncTransport, StateOperation } from '../types.ts';

/** WebSocket transport with automatic reconnection (exponential backoff) and outbound message queueing. */
export class WebSocketTransport implements SyncTransport {
  private _url: string;
  private _protocols: string | string[] | undefined;
  private _ws: WebSocket | null = null;
  private _handler: ((op: StateOperation) => void) | null = null;
  private _queue: StateOperation[] = [];
  private _connected = false;
  private _intentionalClose = false;
  private _reconnectDelay = 1000;
  private _maxReconnectDelay = 30000;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this._url = url;
    this._protocols = protocols;
  }

  send(op: StateOperation): void {
    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(op));
    } else {
      this._queue.push(op);
    }
  }

  onReceive(handler: (op: StateOperation) => void): void {
    this._handler = handler;
  }

  connect(): Promise<void> {
    this._intentionalClose = false;
    this._reconnectDelay = 1000;
    return this._doConnect();
  }

  private _doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this._ws = this._protocols
          ? new WebSocket(this._url, this._protocols)
          : new WebSocket(this._url);
      } catch (e) {
        reject(e);
        return;
      }

      this._ws.onopen = () => {
        this._connected = true;
        this._reconnectDelay = 1000;
        this._flushQueue();
        resolve();
      };

      this._ws.onmessage = (event: MessageEvent) => {
        if (this._handler) {
          try {
            const op = JSON.parse(event.data as string) as StateOperation;
            this._handler(op);
          } catch { /* ignore malformed messages */ }
        }
      };

      this._ws.onclose = () => {
        this._connected = false;
        if (!this._intentionalClose) {
          this._scheduleReconnect();
        }
      };

      this._ws.onerror = () => {
        // onerror is always followed by onclose, so reconnect happens there.
        // Only reject the initial connect promise if we haven't connected yet.
        if (!this._connected) {
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  private _flushQueue(): void {
    while (this._queue.length > 0 && this._connected && this._ws) {
      const op = this._queue.shift()!;
      this._ws.send(JSON.stringify(op));
    }
  }

  private _scheduleReconnect(): void {
    if (this._intentionalClose) return;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect().catch(() => {
        // If reconnect fails, onclose will schedule another attempt
      });
    }, this._reconnectDelay);

    // Exponential backoff
    this._reconnectDelay = Math.min(
      this._reconnectDelay * 2,
      this._maxReconnectDelay
    );
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
  }
}
