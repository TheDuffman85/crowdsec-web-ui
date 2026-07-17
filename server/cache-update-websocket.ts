import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppController } from './app';

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

type AliveWebSocket = WebSocket & { isAlive: boolean };

export interface CacheUpdateWebSocketController {
  close: () => void;
}

interface UpgradeCapableServer {
  on: (event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown;
  off: (event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown;
}

export function attachCacheUpdateWebSocket(
  server: UpgradeCapableServer,
  controller: AppController,
): CacheUpdateWebSocketController {
  const socketPath = `${controller.config.basePath}/api/cache-updates`;
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  webSocketServer.on('connection', (socket) => {
    const aliveSocket = socket as AliveWebSocket;
    aliveSocket.isAlive = true;
    socket.on('pong', () => {
      aliveSocket.isAlive = true;
    });

    socket.send(JSON.stringify({
      type: 'ready',
      updated_at: controller.getCacheLastUpdate(),
    }));
  });

  const unsubscribe = controller.subscribeCacheUpdates((updatedAt) => {
    const payload = JSON.stringify({ type: 'cache-updated', updated_at: updatedAt });
    for (const socket of webSocketServer.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      const aliveSocket = socket as AliveWebSocket;
      if (!aliveSocket.isAlive) {
        socket.terminate();
        continue;
      }
      aliveSocket.isAlive = false;
      socket.ping();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'heartbeat', sent_at: new Date().toISOString() }));
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = request.headers.host;
    if (!host || !isExpectedSocketPath(request.url, host, socketPath) || !isSameOrigin(request, host)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    void authorizeUpgrade(request, controller, host).then((authorized) => {
      if (!authorized || socket.destroyed) {
        if (!socket.destroyed) rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    }).catch(() => {
      if (!socket.destroyed) rejectUpgrade(socket, 401, 'Unauthorized');
    });
  };

  server.on('upgrade', handleUpgrade);

  return {
    close: () => {
      server.off('upgrade', handleUpgrade);
      clearInterval(heartbeat);
      unsubscribe();
      for (const socket of webSocketServer.clients) socket.close(1001, 'Server shutting down');
      webSocketServer.close();
    },
  };
}

function isExpectedSocketPath(requestUrl: string | undefined, host: string, expectedPath: string): boolean {
  try {
    return new URL(requestUrl || '/', `http://${host}`).pathname === expectedPath;
  } catch {
    return false;
  }
}

function isSameOrigin(request: IncomingMessage, host: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function authorizeUpgrade(request: IncomingMessage, controller: AppController, host: string): Promise<boolean> {
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'user-agent', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }

  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const authUrl = `http://${host}${controller.config.basePath}/api/config`;
    const response = await Promise.race([
      controller.fetch(new Request(authUrl, { headers, signal: abortController.signal })),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error('WebSocket authentication timed out'));
        }, AUTH_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
    return response.ok;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
