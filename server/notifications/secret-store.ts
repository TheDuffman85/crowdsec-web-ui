import crypto from 'node:crypto';

const ENCRYPTED_PREFIX = 'enc:v1:';

interface EncryptedEnvelope {
  iv: string;
  tag: string;
  data: string;
}

export interface NotificationSecretStore {
  hasKey(): boolean;
  serializeConfig(config: Record<string, unknown>, hasSecrets: boolean): string;
  parseConfig(serialized: string): { config: Record<string, unknown>; isEncrypted: boolean };
}

export function createNotificationSecretStore(secretKey?: string): NotificationSecretStore {
  const encryptionKey = secretKey
    ? crypto.createHash('sha256').update(secretKey, 'utf8').digest()
    : null;

  return {
    hasKey: () => Boolean(encryptionKey),
    serializeConfig(config, hasSecrets) {
      const payload = JSON.stringify(config);
      if (!hasSecrets) {
        return payload;
      }
      if (!encryptionKey) {
        throw new Error('NOTIFICATION_SECRET_KEY is required to save notification destinations with secrets');
      }

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
      const envelope: EncryptedEnvelope = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      };
      return `${ENCRYPTED_PREFIX}${JSON.stringify(envelope)}`;
    },
    parseConfig(serialized) {
      if (!serialized.startsWith(ENCRYPTED_PREFIX)) {
        return {
          config: parsePlainJsonRecord(serialized),
          isEncrypted: false,
        };
      }

      if (!encryptionKey) {
        throw new Error('NOTIFICATION_SECRET_KEY is required to load encrypted notification destinations');
      }

      try {
        const envelope = JSON.parse(serialized.slice(ENCRYPTED_PREFIX.length)) as Partial<EncryptedEnvelope>;
        const iv = Buffer.from(String(envelope.iv || ''), 'base64');
        const tag = Buffer.from(String(envelope.tag || ''), 'base64');
        const data = Buffer.from(String(envelope.data || ''), 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        return {
          config: parsePlainJsonRecord(decrypted),
          isEncrypted: true,
        };
      } catch {
        throw new Error('Failed to decrypt notification destination configuration');
      }
    },
  };
}

function parsePlainJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
