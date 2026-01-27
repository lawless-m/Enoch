// WebSocket transport layer

export interface TransportOptions {
  url: string;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  reconnect?: boolean;
  reconnectDelay?: number;
}

export class Transport {
  private ws: WebSocket | null = null;
  private options: TransportOptions;
  private reconnectTimer: number | null = null;
  private buffer: Uint8Array[] = [];
  private pendingData: Uint8Array | null = null;

  onMessage: ((data: Uint8Array) => void) | null = null;

  constructor(options: TransportOptions) {
    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      ...options,
    };
  }

  connect(): void {
    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.options.onConnect?.();
    };

    this.ws.onclose = (event) => {
      this.options.onDisconnect?.(event.reason || 'Connection closed');
      if (this.options.reconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.options.onError?.(new Error('WebSocket error'));
    };

    this.ws.onmessage = (event) => {
      this.handleData(new Uint8Array(event.data));
    };
  }

  disconnect(): void {
    this.options.reconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectDelay);
  }

  // Handle incoming data - frame 9P messages
  private handleData(chunk: Uint8Array): void {
    // Prepend any pending partial data
    let data: Uint8Array;
    if (this.pendingData) {
      data = new Uint8Array(this.pendingData.length + chunk.length);
      data.set(this.pendingData);
      data.set(chunk, this.pendingData.length);
      this.pendingData = null;
    } else {
      data = chunk;
    }

    // Process complete 9P messages
    let offset = 0;
    while (offset + 4 <= data.length) {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      const size = view.getUint32(0, true);

      if (offset + size > data.length) {
        // Incomplete message, save for later
        this.pendingData = data.slice(offset);
        return;
      }

      // Complete message
      const msg = data.slice(offset, offset + size);
      this.onMessage?.(msg);
      offset += size;
    }

    // Save any remaining bytes
    if (offset < data.length) {
      this.pendingData = data.slice(offset);
    }
  }
}
