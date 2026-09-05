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
  timeoutMs?: number;
}

export type SmtpTlsMode = 'plain' | 'starttls' | 'tls';

export async function sendSmtpMail(message: SmtpMessage): Promise<void> {
  let activeSocket: net.Socket | tls.TLSSocket | undefined;
  let reader: ReturnType<typeof createSmtpResponseReader> | undefined;
  let deadline: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      const error = new Error('SMTP delivery timed out');
      reject(error);
      activeSocket?.destroy(error);
    }, message.timeoutMs ?? 30_000);
  });
  const deliver = async () => {
    let socket = await connectSmtp(message.host, message.port, message.tlsMode, message.allowInsecureTls === true, (next) => { activeSocket = next; });
    reader = createSmtpResponseReader(socket);
    await readExpectedResponse(reader.read, [220]);
    await smtpCommand(socket, reader.read, 'EHLO localhost', [250]);

    if (message.tlsMode === 'starttls') {
      await smtpCommand(socket, reader.read, 'STARTTLS', [220]);
      reader.dispose();
      socket = await upgradeToTls(socket, message.host, message.allowInsecureTls === true, (next) => { activeSocket = next; });
      reader = createSmtpResponseReader(socket);
      await smtpCommand(socket, reader.read, 'EHLO localhost', [250]);
    }

    if (message.username && message.password) {
      try {
        const authPlain = Buffer.from(`\u0000${message.username}\u0000${message.password}`).toString('base64');
        await smtpCommand(socket, reader.read, `AUTH PLAIN ${authPlain}`, [235]);
      } catch {
        await smtpCommand(socket, reader.read, 'AUTH LOGIN', [334]);
        await smtpCommand(socket, reader.read, Buffer.from(message.username).toString('base64'), [334]);
        await smtpCommand(socket, reader.read, Buffer.from(message.password).toString('base64'), [235]);
      }
    }

    await smtpCommand(socket, reader.read, `MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.to) {
      await smtpCommand(socket, reader.read, `RCPT TO:<${recipient}>`, [250, 251]);
    }

    await smtpCommand(socket, reader.read, 'DATA', [354]);

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
    await readExpectedResponse(reader.read, [250]);
    await smtpCommand(socket, reader.read, 'QUIT', [221]);
  };
  try {
    await Promise.race([deliver(), timeout]);
  } finally {
    clearTimeout(deadline!);
    reader?.dispose();
    activeSocket?.destroy();
  }
}

function connectSmtp(
  host: string,
  port: number,
  tlsMode: SmtpTlsMode,
  allowInsecureTls: boolean,
  onSocket: (socket: net.Socket | tls.TLSSocket) => void,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsMode === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowInsecureTls }, () => resolve(socket))
      : net.createConnection({ host, port }, () => resolve(socket));

    socket.once('error', reject);
    onSocket(socket);
  });
}

function upgradeToTls(socket: net.Socket, host: string, allowInsecureTls: boolean, onSocket: (socket: tls.TLSSocket) => void): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: !allowInsecureTls,
    }, () => resolve(secureSocket));

    secureSocket.once('error', reject);
    onSocket(secureSocket);
  });
}

function createSmtpResponseReader(socket: net.Socket | tls.TLSSocket): { read: () => Promise<string>; dispose: () => void } {
  let buffer = '';
  let lines: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  let failure: Error | null = null;

  const onData = (chunk: Buffer) => {
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
  };

  const onError = (error: Error) => {
    failure = error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.('');
    }
  };
  const onClose = () => onError(new Error('SMTP connection closed before delivery completed'));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onClose);
  socket.on('close', onClose);
  if (socket.destroyed || socket.readableEnded) onClose();

  const read = async () =>
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
  return {
    read,
    dispose: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onClose);
      socket.off('close', onClose);
    },
  };
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
