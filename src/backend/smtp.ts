import net from 'node:net';
import tls from 'node:tls';

export interface SmtpMessage {
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  allowInsecureTls?: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export type SmtpTlsMode = 'plain' | 'starttls' | 'tls';

export async function sendSmtpMail(message: SmtpMessage): Promise<void> {
  let socket = await connectSmtp(message.host, message.port, message.tlsMode, message.allowInsecureTls === true);
  let reader = createSmtpResponseReader(socket);

  try {
    await readExpectedResponse(reader, [220]);
    await smtpCommand(socket, reader, 'EHLO localhost', [250]);

    if (message.tlsMode === 'starttls') {
      await smtpCommand(socket, reader, 'STARTTLS', [220]);
      socket = await upgradeToTls(socket, message.host, message.allowInsecureTls === true);
      reader = createSmtpResponseReader(socket);
      await smtpCommand(socket, reader, 'EHLO localhost', [250]);
    }

    if (message.username && message.password) {
      try {
        const authPlain = Buffer.from(`\u0000${message.username}\u0000${message.password}`).toString('base64');
        await smtpCommand(socket, reader, `AUTH PLAIN ${authPlain}`, [235]);
      } catch {
        await smtpCommand(socket, reader, 'AUTH LOGIN', [334]);
        await smtpCommand(socket, reader, Buffer.from(message.username).toString('base64'), [334]);
        await smtpCommand(socket, reader, Buffer.from(message.password).toString('base64'), [235]);
      }
    }

    await smtpCommand(socket, reader, `MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.to) {
      await smtpCommand(socket, reader, `RCPT TO:<${recipient}>`, [250, 251]);
    }

    await smtpCommand(socket, reader, 'DATA', [354]);

    const payload = [
      `From: ${message.from}`,
      `To: ${message.to.join(', ')}`,
      `Subject: ${message.subject}`,
      'Content-Type: text/plain; charset="utf-8"',
      'MIME-Version: 1.0',
      '',
      dotStuff(message.text),
    ].join('\r\n');

    socket.write(`${payload}\r\n.\r\n`);
    await readExpectedResponse(reader, [250]);
    await smtpCommand(socket, reader, 'QUIT', [221]);
  } finally {
    socket.destroy();
  }
}

function connectSmtp(
  host: string,
  port: number,
  tlsMode: SmtpTlsMode,
  allowInsecureTls: boolean,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsMode === 'tls'
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: !allowInsecureTls }, () => resolve(socket))
      : net.createConnection({ host, port }, () => resolve(socket));

    socket.once('error', reject);
  });
}

function upgradeToTls(socket: net.Socket, host: string, allowInsecureTls: boolean): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: host,
      rejectUnauthorized: !allowInsecureTls,
    }, () => resolve(secureSocket));

    secureSocket.once('error', reject);
  });
}

function createSmtpResponseReader(socket: net.Socket | tls.TLSSocket): () => Promise<string> {
  let buffer = '';
  let lines: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  let failure: Error | null = null;

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      lines.push(line);

      if (/^\d{3} /.test(line) && waiters.length > 0) {
        const waiter = waiters.shift();
        const response = lines.join('\n');
        lines = [];
        waiter?.(response);
      }

      newlineIndex = buffer.indexOf('\n');
    }
  });

  socket.on('error', (error) => {
    failure = error as Error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.('');
    }
  });

  return async () =>
    new Promise<string>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }

      if (lines.length > 0 && /^\d{3} /.test(lines[lines.length - 1] || '')) {
        const response = lines.join('\n');
        lines = [];
        resolve(response);
        return;
      }

      waiters.push((response) => {
        if (failure) {
          reject(failure);
          return;
        }
        resolve(response);
      });
    });
}

async function smtpCommand(
  socket: net.Socket | tls.TLSSocket,
  readResponse: () => Promise<string>,
  command: string,
  expectedCodes: number[],
): Promise<string> {
  socket.write(`${command}\r\n`);
  return readExpectedResponse(readResponse, expectedCodes);
}

async function readExpectedResponse(readResponse: () => Promise<string>, expectedCodes: number[]): Promise<string> {
  const response = await readResponse();
  const code = Number.parseInt(response.slice(0, 3), 10);
  if (!expectedCodes.includes(code)) {
    throw new Error(response || 'SMTP command failed');
  }
  return response;
}

function dotStuff(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}
