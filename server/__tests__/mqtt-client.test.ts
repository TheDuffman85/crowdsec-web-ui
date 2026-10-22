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
