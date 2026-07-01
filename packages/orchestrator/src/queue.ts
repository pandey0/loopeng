import { Queue as BullQueue, Worker } from "bullmq";
import IORedis from "ioredis";

export type JobHandler<T> = (data: T) => Promise<void>;

export interface JobQueue<T> {
  enqueue(data: T): Promise<void>;
  process(handler: JobHandler<T>, concurrency?: number): void;
  close(): Promise<void>;
}

// Single-consumer, in-memory FIFO — no durability across process restarts.
// Same JobQueue shape as the Redis-backed queue, so swapping REDIS_URL in
// later is a config change, not a rewrite of anything that enqueues jobs.
export class InProcessQueue<T> implements JobQueue<T> {
  private readonly items: T[] = [];
  private handler: JobHandler<T> | null = null;
  private draining = false;

  async enqueue(data: T): Promise<void> {
    this.items.push(data);
    this.drain();
  }

  process(handler: JobHandler<T>): void {
    this.handler = handler;
    this.drain();
  }

  private drain(): void {
    if (this.draining || !this.handler) return;
    this.draining = true;
    void (async () => {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (item === undefined) continue;
        try {
          await this.handler!(item);
        } catch (err) {
          console.error("[orchestrator:queue] job failed", err);
        }
      }
      this.draining = false;
    })();
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export class RedisQueue<T> implements JobQueue<T> {
  // bullmq's own generics fight any T we pick here (they're keyed off the
  // job-name literal, not just the data shape) — the JobQueue<T> interface
  // above is the real type boundary this class enforces for its callers.
  private readonly queue: BullQueue;
  private readonly connection: IORedis;
  private worker: Worker | null = null;

  constructor(
    private readonly name: string,
    redisUrl: string,
  ) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new BullQueue(name, { connection: this.connection });
  }

  async enqueue(data: T): Promise<void> {
    await this.queue.add(this.name, data as object);
  }

  process(handler: JobHandler<T>, concurrency = 1): void {
    this.worker = new Worker(this.name, async (job) => handler(job.data as T), {
      connection: this.connection,
      concurrency,
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}

export async function createQueue<T>(name: string): Promise<JobQueue<T>> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn(`[orchestrator:queue] REDIS_URL not set, using in-process queue for "${name}"`);
    return new InProcessQueue<T>();
  }
  try {
    const probe = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    await probe.connect();
    await probe.disconnect();
    return new RedisQueue<T>(name, redisUrl);
  } catch (err) {
    console.warn(`[orchestrator:queue] Redis unreachable at ${redisUrl}, falling back to in-process queue:`, (err as Error).message);
    return new InProcessQueue<T>();
  }
}
