import { setTimeout as sleep } from "node:timers/promises";

const delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal });

export class SerialJobQueue {
  constructor({ onError = () => {} } = {}) {
    this.tail = Promise.resolve();
    this.closed = false;
    this.onError = onError;
  }

  enqueue(job) {
    if (this.closed) return Promise.resolve();
    const running = this.tail.catch(() => {}).then(() => { if (!this.closed) return job(); });
    const handled = running.catch((error) => {
      this.onError(error);
    });
    this.tail = handled;
    return handled;
  }

  stop() { this.closed = true; }

  onIdle() {
    return this.tail;
  }
}

export class TelegramPoller {
  constructor({ telegram, onUpdate, logger = console, retryDelay = delay } = {}) {
    Object.assign(this, { telegram, onUpdate, logger, retryDelay });
    this.offset = 0;
    this.stopped = false;
    this.state = "starting";
    this.controller = new AbortController();
  }

  stop() {
    this.stopped = true;
    this.state = "stopped";
    this.controller.abort();
    return this.running;
  }

  pollOnce() {
    // Both direct callers and start() share one in-flight getUpdates request.
    if (!this.inFlight) {
      this.inFlight = this.fetchUpdates().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async fetchUpdates() {
    if (this.stopped) return;
    const updates = await this.telegram("getUpdates", {
      offset: this.offset, timeout: 30, allowed_updates: ["message"],
    }, { signal: this.controller.signal });
    if (this.stopped) return;
    if (!Array.isArray(updates)) throw new Error("Malformed Telegram updates");
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < this.offset) continue;
      this.offset = update.update_id + 1;
      try {
        Promise.resolve(this.onUpdate(update)).catch(() => {
          this.logger.error("[telegram] async update dispatch failed");
        });
      } catch {
        this.logger.error("[telegram] update dispatch failed");
      }
    }
  }

  start() {
    if (!this.running) this.running = this.run();
    return this.running;
  }

  async run() {
    let failures = 0;
    this.logger.log("[telegram] polling started");
    while (!this.stopped) {
      try {
        this.state = "running";
        await this.pollOnce();
        failures = 0;
      } catch (error) {
        if (this.stopped) break;
        const code = Number(error?.code);
        if (code === 409) {
          // Never fight another host for ownership or trigger a restart storm.
          this.state = "conflict";
          this.logger.error("[telegram] 409: duplicate poller or webhook detected; polling suspended. Stop other instances/remove webhook, then restart this service.");
          break;
        }
        if (code === 401 || code === 403) {
          this.state = "unauthorized";
          this.logger.error("[telegram] authentication rejected; polling suspended");
          break;
        }
        this.state = "recovering";
        const backoff = Math.min(60_000, 3_000 * 2 ** Math.min(failures++, 5));
        const retryAfter = Number(error?.retryAfter);
        const wait = Math.max(backoff, Number.isFinite(retryAfter) ? Math.min(300_000, Math.max(0, retryAfter * 1000)) : 0);
        this.logger.error(`[telegram] temporary polling failure; retry in ${wait}ms`);
        try { await this.retryDelay(wait, this.controller.signal); }
        catch { if (!this.stopped) throw new Error("Polling delay failed"); }
      }
    }
  }
}
