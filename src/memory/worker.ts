import { logger } from "../logger.js";
import * as store from "./store.js";
import type { MemoryJobKind } from "./types.js";

type MemoryJobHandler = (payload: Record<string, unknown>) => Promise<void>;

export class MemoryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private handlers: Partial<Record<MemoryJobKind, MemoryJobHandler>>,
    private pollIntervalMs: number = 5000,
    private batchSize: number = 10,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.currentRun;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.currentRun = (async () => {
      try {
        const jobs = store.listDueMemoryJobs(this.batchSize);
        for (const job of jobs) {
          await this.runJob(job);
        }
      } finally {
        this.running = false;
        this.currentRun = null;
      }
    })();

    await this.currentRun;
  }

  private async runJob(job: {
    id: string;
    kind: string;
    payloadJson: string;
    attempts: number;
    runAfter: number;
  }): Promise<void> {
    const handler = this.handlers[job.kind as MemoryJobKind];
    if (!handler) {
      logger.warn("memory.job.no_handler", { kind: job.kind, jobId: job.id });
      store.markMemoryJobFailed(job as never, `No handler for ${job.kind}`, Date.now(), "failed");
      return;
    }

    const claimed = store.tryMarkMemoryJobRunning(job as never);
    if (!claimed) {
      logger.info("memory.job.claim_skipped", { kind: job.kind, jobId: job.id });
      return;
    }

    try {
      const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
      await handler(payload);
      store.markMemoryJobCompleted(job as never);
    } catch (error) {
      const backoffMs = Math.min(60_000, 5_000 * Math.max(1, job.attempts + 1));
      logger.warn("memory.job.failed", {
        kind: job.kind,
        jobId: job.id,
        attempts: job.attempts + 1,
        error,
      });
      store.markMemoryJobFailed(job as never, error, Date.now() + backoffMs);
    }
  }
}
