import net from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { sendSmtpMail } from '../../smtp';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function listen(handler: (socket: net.Socket) => void) {
  const server = net.createServer(socket => { sockets.add(socket); handler(socket); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}
const message = { host: '127.0.0.1', tlsMode: 'plain' as const, from: 'a@example.test', to: ['b@example.test'], subject: 'Test', text: '.Test', timeoutMs: 500 };

test('rejects a clean disconnect before the greeting', async () => {
  const port = await listen(socket => socket.end());
  await expect(sendSmtpMail({ ...message, port })).rejects.toThrow('SMTP connection closed');
});

test('rejects a clean disconnect during a command', async () => {
  const port = await listen(socket => { socket.write('220 Ready\r\n'); socket.once('data', () => socket.end()); });
  await expect(sendSmtpMail({ ...message, port })).rejects.toThrow('SMTP connection closed');
});

test('bounds a silent connection with a delivery deadline', async () => {
  const port = await listen(() => {});
  await expect(sendSmtpMail({ ...message, port, timeoutMs: 40 })).rejects.toThrow('SMTP delivery timed out');
});

test('bounds a stalled STARTTLS handshake with the same deadline', async () => {
  const port = await listen(socket => {
    socket.write('220 Ready\r\n');
    socket.on('data', data => {
      if (data.toString().startsWith('EHLO')) socket.write('250 STARTTLS\r\n');
      if (data.toString().startsWith('STARTTLS')) socket.write('220 Upgrade\r\n');
    });
  });
  await expect(sendSmtpMail({ ...message, port, tlsMode: 'starttls', timeoutMs: 100 })).rejects.toThrow('SMTP delivery timed out');
});

test('delivers and dot-stuffs a message, including a closing QUIT reply', async () => {
  let payload = '';
  const port = await listen(socket => {
    socket.write('220 Ready\r\n');
    socket.on('data', data => {
      const command = data.toString();
      if (command.startsWith('DATA')) socket.write('354 Send\r\n');
      else if (command.startsWith('QUIT')) socket.end('221 Bye\r\n');
      else { if (command.startsWith('From:')) payload = command; socket.write('250 OK\r\n'); }
    });
  });
  await expect(sendSmtpMail({ ...message, port })).resolves.toBeUndefined();
  expect(payload).toContain('\r\n..Test\r\n.\r\n');
});
