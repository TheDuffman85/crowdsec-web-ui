import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AppController } from '../app';
import { attachCacheUpdateWebSocket } from '../cache-update-websocket';

const cleanups: Array<() => Promise<void>> = [];
const revision = '2026-10-29T10:00:00.000Z';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startServer(fetch = vi.fn<AppController['fetch']>().mockResolvedValue(new Response('{}'))) {
  const server = createServer((_request, response) => response.end('ok'));
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const handler = attachCacheUpdateWebSocket(server, {
    config: { basePath: '' },
    fetch,
    getCacheLastUpdate: () => revision,
    subscribeCacheUpdates: () => () => {},
  } as unknown as AppController);
  cleanups.push(async () => {
    handler.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `ws://127.0.0.1:${port}/api/cache-updates` };
}

async function connectRaw(port: number) {
  const client = connect(port, '127.0.0.1');
  cleanups.push(async () => { client.destroy(); });
  await once(client, 'connect');
  client.write([
    'GET /api/cache-updates HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n'));
  return client;
}

async function expectHealthyConnection(url: string) {
  const client = new WebSocket(url);
  try {
    const [message] = await once(client, 'message');
    expect(JSON.parse(message.toString())).toEqual({ type: 'ready', updated_at: revision });
    const closed = once(client, 'close');
    client.close();
    await closed;
  } finally {
    client.terminate();
  }
}

test.each([
  ['an unmasked frame', Buffer.from([0x81, 0x00])],
  ['invalid UTF-8', Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0xff])],
])('closes only the offending WebSocket after receiving %s', async (_description, frame) => {
  const { port, url } = await startServer();
  const client = await connectRaw(port);
  const [response] = await once(client, 'data');
  expect(response.toString()).toContain('HTTP/1.1 101 Switching Protocols');

  const closed = once(client, 'close');
  client.write(frame);
  await closed;

  await expectHealthyConnection(url);
});

test.each([200, 401])('survives a TCP reset while authentication is pending and later returns %s', async (status) => {
  let resolveAuthentication!: (response: Response) => void;
  const authentication = new Promise<Response>((resolve) => { resolveAuthentication = resolve; });
  const fetch = vi.fn<AppController['fetch']>()
    .mockResolvedValue(new Response('{}'))
    .mockImplementationOnce(() => authentication);
  const { server, port, url } = await startServer(fetch);
  const upgraded = new Promise<Socket>((resolve) => {
    server.once('upgrade', (_request, socket) => resolve(socket as Socket));
  });
  const client = await connectRaw(port);
  const socket = await upgraded;
  expect(fetch).toHaveBeenCalledTimes(1);

  // Do not use events.once(): its error listener would hide the regression.
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  client.resetAndDestroy();
  await closed;
  expect(socket.destroyed).toBe(true);

  resolveAuthentication(new Response('{}', { status }));
  await setImmediate();
  await expectHealthyConnection(url);
});
