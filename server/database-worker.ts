import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// SQLite is synchronous native code: terminating a JS worker thread cannot
// interrupt a running statement. A persistent process gives timeouts an actual
// cancellation boundary, including during native-addon initialization.
const children = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

export class DatabaseWorker extends EventEmitter {
  private readonly child: ChildProcess;
  private readonly shutdown: Promise<number>;
  exited = false;

  constructor(url: URL, options: { workerData: unknown; execArgv: string[] }) {
    super();
    this.child = fork(url, [JSON.stringify(options.workerData)], {
      execArgv: options.execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.add(this.child);
    this.shutdown = new Promise((resolve) => {
      const finish = (code: number | null) => {
        if (this.exited) return;
        this.exited = true;
        children.delete(this.child);
        this.emit('exit', code ?? 1);
        resolve(code ?? 1);
      };
      this.child.once('exit', finish);
      // Failed spawns emit close without exit.
      this.child.once('close', finish);
    });
    this.child.on('message', (message) => this.emit('message', message));
    this.child.on('error', (error) => this.emit('error', error));
  }

  postMessage(message: unknown): void {
    if (this.exited || !this.child.connected) throw new Error('Database worker is disconnected');
    this.child.send(message as object, (error) => {
      if (error && !this.exited) this.emit('error', error);
    });
  }

  terminate(): Promise<number> {
    if (!this.exited) this.child.kill('SIGKILL');
    return this.shutdown;
  }

  unref(): void {
    this.child.unref();
    this.child.channel?.unref();
  }
}
