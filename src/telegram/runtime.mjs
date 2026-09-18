const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class SerialJobQueue {
  constructor({ onError = () => {} } = {}) {
    this.tail = Promise.resolve();
    this.onError = onError;
  }

  enqueue(job) {
    const running = this.tail.catch(() => {}).then(job);
    const handled = running.catch((error) => {
      this.onError(error);
    });
    this.tail = handled;
    return handled;
  }

  onIdle() {
    return this.tail;
  }
}

export class TelegramPoller {
  constructor({ telegram, onUpdate, logger = console, retryDelay = delay } = {}) {
    this.telegram = telegram;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.retryDelay = retryDelay;
    this.offset = 0;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async pollOnce() {
    const updates = await this.telegram("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message"],
    });
    if (!Array.isArray(updates)) throw new Error("Telegram returned malformed updates.");
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      this.logger.log(`[telegram] update received ${update.update_id}`);
      try {
        const dispatched = this.onUpdate(update);
        Promise.resolve(dispatched).catch((error) => {
          this.logger.error(`[telegram] async update dispatch failed (${error.code || "internal"})`);
        });
      } catch (error) {
        this.logger.error(`[telegram] update dispatch failed (${error.code || "internal"})`);
      }
    }
  }

  async start() {
    this.logger.log("[telegram] polling started");
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.stopped) {
          this.logger.error(`[telegram] polling failed (${error.code || "internal"})`);
          await this.retryDelay(3_000);
        }
      }
    }
  }
}
