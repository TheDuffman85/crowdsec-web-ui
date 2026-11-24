import crypto from 'node:crypto';

export interface SshKeyPair {
  /** OpenSSH private key file contents. */
  privateKey: string;
  /** One authorized_keys line (without options). */
  publicKey: string;
}

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/** A fresh ed25519 key pair in the formats the ssh client and authorized_keys expect. */
export function generateSshKeyPair(comment: string): SshKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');

  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicBytes)]);
  const check = crypto.randomBytes(4);
  let privateSection = Buffer.concat([
    check, check,
    sshString('ssh-ed25519'), sshString(publicBytes), sshString(Buffer.concat([seed, publicBytes])), sshString(comment),
  ]);
  const padding = (8 - (privateSection.length % 8)) % 8;
  privateSection = Buffer.concat([privateSection, Buffer.from(Array.from({ length: padding }, (_, index) => index + 1))]);

  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const file = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'), sshString('none'), sshString(''),
    count, sshString(publicBlob), sshString(privateSection),
  ]);
  const wrapped = file.toString('base64').match(/.{1,70}/g)!.join('\n');
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
  };
}

/** Lowercase letters, digits and dashes, safe in file names and ids. */
export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'server';
}
