import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import mqtt from 'mqtt';
import { publishMqttNotification } from '../notifications/mqtt-client';

vi.mock('mqtt', () => ({ default: { connect: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('times out a connected broker that never acknowledges a publish or completes teardown', async () => {
  vi.useFakeTimers();
  const client = Object.assign(new EventEmitter(), { publish: vi.fn(), end: vi.fn() });
  vi.mocked(mqtt.connect).mockReturnValue(client as unknown as ReturnType<typeof mqtt.connect>);
  const failed = expect(publishMqttNotification({
    brokerUrl: 'mqtt://localhost', keepaliveSeconds: 60, connectTimeoutMs: 1000,
    qos: 1, topic: 'alerts', retainEvents: false,
  }, 'payload')).rejects.toThrow('MQTT delivery exceeded 31000ms timeout');
  client.emit('connect');
  await vi.advanceTimersByTimeAsync(31000);
  await failed;
  expect(client.end).toHaveBeenCalledExactlyOnceWith(true);
  expect(vi.getTimerCount()).toBe(0);
  // Late socket events cannot settle twice or become unhandled errors.
  client.emit('error', new Error('late socket failure'));
  client.emit('close');
});

test('connects plain TCP brokers to the address the lookup validated', async () => {
  const client = Object.assign(new EventEmitter(), { publish: vi.fn((_t, _p, _o, done: () => void) => done()), end: vi.fn() });
  vi.mocked(mqtt.connect).mockImplementation(() => {
    queueMicrotask(() => client.emit('connect'));
    return client as unknown as ReturnType<typeof mqtt.connect>;
  });
  const lookup = vi.fn((_host: string, _options: unknown, callback: (error: Error | null, address: string) => void) => callback(null, '203.0.113.7'));

  await publishMqttNotification({
    brokerUrl: 'mqtt://broker.example:1883', keepaliveSeconds: 60, connectTimeoutMs: 1000,
    qos: 0, topic: 'alerts', retainEvents: false, lookup: lookup as never,
  }, 'payload');

  expect(lookup).toHaveBeenCalledWith('broker.example', {}, expect.any(Function));
  expect(vi.mocked(mqtt.connect).mock.calls.at(-1)?.[1]).toMatchObject({ hostname: '203.0.113.7' });
});
