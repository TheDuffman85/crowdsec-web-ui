import http from 'node:http';
import type { AddressInfo } from 'node:net';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createNotificationOutboundGuard } from '../../notifications/outbound-guard';

describe('notification outbound guard', () => {
  const guard = createNotificationOutboundGuard({ allowPrivateAddresses: false });

  test.each([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a00:1',
    '::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    'fd12::1',
  ])('rejects the restricted host %s', async (host) => {
    await expect(guard.assertHostAllowed(host, 'SMTP host')).rejects.toThrow('restricted address');
  });

  test.each(['8.8.8.8', '::ffff:8.8.8.8', '::ffff:808:808', '2606:4700::1111', '64:ff9b::808:808'])('accepts the public host %s', async (host) => {
    await expect(guard.assertHostAllowed(host, 'SMTP host')).resolves.toBeUndefined();
  });

  test('checks IPv6 literals in URLs without their brackets', async () => {
    await expect(guard.assertUrlAllowed('http://[::ffff:127.0.0.1]:8080/', 'Gotify URL')).rejects.toThrow('restricted address');
    await expect(guard.assertUrlAllowed('https://[2606:4700::1111]/', 'Gotify URL')).resolves.toBeUndefined();
  });

  test('allows local destinations when private addresses are allowed', async () => {
    const permissive = createNotificationOutboundGuard({ allowPrivateAddresses: true });
    await expect(permissive.assertHostAllowed('::ffff:7f00:1', 'SMTP host')).resolves.toBeUndefined();
    await expect(permissive.assertUrlAllowed('http://localhost:8080/', 'Gotify URL')).resolves.toBeUndefined();
  });

  describe('connection pinning', () => {
    let server: http.Server | undefined;

    afterEach(async () => {
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    async function startServer(): Promise<number> {
      server = http.createServer((_request, response) => response.end('internal secret'));
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    }

    // Answers with a public address on the first lookup and loopback afterwards.
    function mockRebindingDns() {
      let calls = 0;
      return vi.spyOn(dns, 'lookup').mockImplementation((async () => {
        calls += 1;
        return [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
      }) as unknown as typeof dns.lookup);
    }

    test('fetch rejects a hostname that rebinds to loopback after validation', async () => {
      const port = await startServer();
      mockRebindingDns();
      const url = `http://rebind.example:${port}/`;

      await expect(guard.assertUrlAllowed(url, 'Webhook URL')).resolves.toBeUndefined();
      await expect(guard.fetch(url)).rejects.toThrow('restricted address (127.0.0.1)');
    });

    test('lookup rejects restricted answers and returns allowed ones', async () => {
      vi.spyOn(dns, 'lookup').mockImplementation((async (host: string) => [
        { address: host === 'public.example' ? '8.8.8.8' : '10.0.0.1', family: 4 },
      ]) as unknown as typeof dns.lookup);
      const lookup = (host: string, all: boolean) => new Promise((resolve, reject) => {
        guard.lookup(host, { all }, (error, address) => (error ? reject(error) : resolve(address)));
      });

      await expect(lookup('private.example', false)).rejects.toThrow('restricted address (10.0.0.1)');
      await expect(lookup('public.example', false)).resolves.toBe('8.8.8.8');
      await expect(lookup('public.example', true)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
    });

    test('fetch connects through the guarded lookup when private addresses are allowed', async () => {
      const port = await startServer();
      vi.spyOn(dns, 'lookup').mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof dns.lookup);
      const permissive = createNotificationOutboundGuard({ allowPrivateAddresses: true });

      const response = await permissive.fetch(`http://internal.example:${port}/`);
      await expect(response.text()).resolves.toBe('internal secret');
    });
  });
});
