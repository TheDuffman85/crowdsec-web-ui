import mqtt, { type IClientOptions } from 'mqtt';
import type { LookupFunction } from 'node:net';

export interface MqttPublishConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepaliveSeconds: number;
  connectTimeoutMs: number;
  qos: 0 | 1;
  topic: string;
  retainEvents: boolean;
  // Resolves the broker host for the socket, e.g. to restrict which addresses may be reached.
  lookup?: LookupFunction;
}

export async function publishMqttNotification(config: MqttPublishConfig, payload: string): Promise<void> {
  const connectOptions = await resolveConnectOptions(config);
  await new Promise<void>((resolve, reject) => {
    const client = mqtt.connect(config.brokerUrl, {
      ...connectOptions,
      username: config.username || undefined,
      password: config.password || undefined,
      clientId: config.clientId || undefined,
      keepalive: config.keepaliveSeconds,
      connectTimeout: config.connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    // connectTimeout does not cover a broker that connects but never ACKs a
    // QoS 1 publish. Bound the entire delivery, including socket teardown.
    const timeoutMs = config.connectTimeoutMs + 30_000;
    const timeout = setTimeout(() => finalize(new Error(`MQTT delivery exceeded ${timeoutMs}ms timeout`)), timeoutMs);
    const finalize = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.removeAllListeners();
      // Ignore socket errors during forced shutdown; completion must not wait
      // for another callback from an already unresponsive connection.
      client.on('error', () => {});
      try { client.end(true); } catch (closeError) {
        error ??= closeError instanceof Error ? closeError : new Error(String(closeError));
      }
      if (error) reject(error);
      else resolve();
    };

    client.once('connect', () => {
      client.publish(config.topic, payload, { qos: config.qos, retain: config.retainEvents }, (error) => {
        if (error) {
          finalize(error);
          return;
        }
        finalize();
      });
    });

    client.once('error', (error) => finalize(error instanceof Error ? error : new Error(String(error))));
    client.once('close', () => {
      if (!settled) {
        finalize(new Error('MQTT connection closed before publish completed'));
      }
    });
  });
}

async function resolveConnectOptions(config: MqttPublishConfig): Promise<IClientOptions> {
  const lookup = config.lookup;
  if (!lookup) return {};
  const url = new URL(config.brokerUrl);
  if (url.protocol === 'mqtt:' || url.protocol === 'tcp:') {
    // mqtt.js does not pass a lookup to plain TCP sockets, so connect to the resolved address directly.
    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const address = await new Promise<string>((resolve, reject) => {
      lookup(hostname, {}, (error, result) => {
        if (error) reject(error);
        else resolve(typeof result === 'string' ? result : result[0].address);
      });
    });
    return { hostname: address };
  }
  // TLS and WebSocket sockets resolve through the lookup and still verify the broker's hostname.
  return { lookup, wsOptions: { lookup } } as IClientOptions;
}
