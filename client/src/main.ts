// Enoch - Browser-based 9front terminal client

import { Transport } from './transport.js';
import { Client9P } from './9p/client.js';
import { NOFID } from './9p/types.js';
import { ConsDevice } from './devices/cons.js';
import { Terminal } from './ui/terminal.js';

// Configuration
const DEFAULT_MSIZE = 8192;
const DEFAULT_USER = 'none';

class Enoch {
  private transport: Transport;
  private client: Client9P;
  private cons: ConsDevice;
  private terminal: Terminal;
  private statusEl: HTMLElement;

  constructor() {
    this.statusEl = document.getElementById('status')!;
    this.terminal = new Terminal('terminal');

    // Determine WebSocket URL
    const wsUrl = this.getWebSocketUrl();
    this.setStatus('Connecting...', 'connecting');

    // Create transport
    this.transport = new Transport({
      url: wsUrl,
      onConnect: () => this.onConnect(),
      onDisconnect: (reason) => this.onDisconnect(reason),
      onError: (err) => this.onError(err),
      reconnect: true,
      reconnectDelay: 2000,
    });

    // Create 9P client
    this.client = new Client9P(this.transport);

    // Create console device
    this.cons = new ConsDevice(this.client);

    // Wire up terminal input to console write
    this.terminal.setInputHandler((data) => {
      this.cons.write(data).catch((err) => {
        console.error('Write error:', err);
      });
    });

    // Wire up console data to terminal display
    this.cons.setDataHandler((data) => {
      this.terminal.write(data);
    });

    this.cons.setErrorHandler((err) => {
      console.error('Console read error:', err);
    });
  }

  private getWebSocketUrl(): string {
    // Use query parameter if provided
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get('url');
    if (urlParam) {
      return urlParam;
    }

    // Default: same host, /cpu path, ws/wss based on current protocol
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/cpu`;
  }

  start(): void {
    this.transport.connect();
  }

  private async onConnect(): Promise<void> {
    this.setStatus('Connected', 'connected');

    try {
      // Version negotiation
      const rv = await this.client.version(DEFAULT_MSIZE);
      console.log(`Version: msize=${rv.msize}, version=${rv.version}`);

      // Attach (no auth for now)
      const rootFid = this.client.allocFid();
      await this.client.attach(rootFid, NOFID, DEFAULT_USER, '');
      console.log('Attached to root');

      // Open console
      await this.cons.open();
      console.log('Console opened');

      // Start reading from console
      this.cons.startReading(2);

      this.setStatus('Ready', 'connected');
    } catch (e) {
      console.error('Session setup failed:', e);
      this.setStatus(`Error: ${e}`, 'error');
      this.terminal.writeText(`\n*** Connection failed: ${e}\n`);
    }
  }

  private onDisconnect(reason: string): void {
    this.setStatus(`Disconnected: ${reason}`, 'error');
    this.cons.stopReading();
    this.terminal.writeText(`\n*** Disconnected: ${reason}\n`);
  }

  private onError(err: Error): void {
    console.error('Transport error:', err);
    this.setStatus(`Error: ${err.message}`, 'error');
  }

  private setStatus(text: string, state: 'connecting' | 'connected' | 'error'): void {
    this.statusEl.textContent = text;
    this.statusEl.className = state;
  }
}

// Start on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  const app = new Enoch();
  app.start();
});
