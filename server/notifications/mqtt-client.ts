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
    const finalize = (error?: Error) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      client.end(true, () => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
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
