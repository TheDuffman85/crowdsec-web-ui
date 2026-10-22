import mqtt from 'mqtt';

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
}

export async function publishMqttNotification(config: MqttPublishConfig, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = mqtt.connect(config.brokerUrl, {
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
