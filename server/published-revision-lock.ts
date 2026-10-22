type Release = () => void;
type Writer = {
  resolve: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Readers keep seeing one committed revision. A writer that times out is
// removed from the queue, so it can never acquire the lock after rollback.
export class PublishedRevisionLock {
  private readers = 0;
  private writing = false;
  private readonly waitingReaders: Array<(release: Release) => void> = [];
  private readonly waitingWriters: Writer[] = [];

  constructor(private readonly timeoutMs: number) {}

  acquireRead(): Promise<Release> {
    if (!this.writing && this.waitingWriters.length === 0) {
      return Promise.resolve(this.grantRead());
    }
    return new Promise((resolve) => this.waitingReaders.push(resolve));
  }

  acquireWrite(): Promise<Release> {
    if (!this.writing && this.readers === 0 && this.waitingWriters.length === 0) {
      return Promise.resolve(this.grantWrite());
    }
    return new Promise((resolve, reject) => {
      const writer: Writer = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waitingWriters.indexOf(writer);
          if (index === -1) return;
          this.waitingWriters.splice(index, 1);
          reject(new Error(`Cache publication waited more than ${this.timeoutMs}ms for readers/writers to finish`));
          this.drain();
        }, this.timeoutMs),
      };
      this.waitingWriters.push(writer);
    });
  }

  private grantRead(): Release {
    this.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers -= 1;
      this.drain();
    };
  }

  private grantWrite(): Release {
    this.writing = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writing = false;
      this.drain();
    };
  }

  private drain(): void {
    if (this.writing) return;
    if (this.waitingWriters.length > 0) {
      if (this.readers > 0) return;
      const writer = this.waitingWriters.shift()!;
      clearTimeout(writer.timer);
      writer.resolve(this.grantWrite());
      return;
    }
    for (const resolve of this.waitingReaders.splice(0)) resolve(this.grantRead());
  }
}
