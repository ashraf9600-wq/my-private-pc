const malaysiaDate = new Intl.DateTimeFormat("ms-MY", {
  timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "long", year: "numeric",
});
const malaysiaClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function formatMalaysiaTime(date) {
  const parts = Object.fromEntries(malaysiaClock.formatToParts(date).map(({ type, value }) => [type, value]));
  const hour = Number(parts.hour);
  const period = hour < 12 ? "pagi" : hour < 14 ? "tengah hari" : hour < 19 ? "petang" : "malam";
  return `${malaysiaDate.format(date)}, ${hour % 12 || 12}:${parts.minute} ${period}`;
}

export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  const parts = [];
  if (days) parts.push(`${days} hari`);
  if (hours) parts.push(`${hours} jam`);
  if (minutes) parts.push(`${minutes} minit`);
  return parts.join(" ") || `${total} saat`;
}

export function isHealthCommand(text) {
  return /^\/(?:ping|status)(?:@\w+)?$/i.test(text.trim());
}

// Authentication still happens inside job through the existing access gate.
// Only these read-only commands bypass the serial assistant queue.
export function dispatchMessageJob(text, job, queue) {
  return isHealthCommand(text) ? job() : queue.enqueue(job);
}

export function createRuntimeStatus({ now = () => new Date(), uptime = () => process.uptime() } = {}) {
  let activeJobs = 0;
  let lastSuccess = null;
  return {
    async runJob(job) {
      activeJobs++;
      try {
        const result = await job();
        lastSuccess = now();
        return result;
      } finally {
        activeJobs--;
      }
    },
    reply(text) {
      if (!isHealthCommand(text)) return null;
      if (/^\/ping(?:@\w+)?$/i.test(text.trim())) {
        return `🟢 ASHRAF AI ONLINE\nStatus: Ready\nUptime: ${formatUptime(uptime())}\nTime: ${formatMalaysiaTime(now())}`;
      }
      return `🤖 ASHRAF AI STATUS\n\nTelegram: 🟢 Online\nCodex: ${activeJobs > 0 ? "🟡 Busy" : "🟢 Ready"}\nModel: GPT-5.6 Sol\nMemory: 🟢 Loaded\nUptime: ${formatUptime(uptime())}\nActive jobs: ${activeJobs}\nLast successful Codex job: ${lastSuccess ? formatMalaysiaTime(lastSuccess) : "Belum ada"}`;
    },
  };
}
