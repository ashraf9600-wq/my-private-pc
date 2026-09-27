import os from "node:os";
import { statfs } from "node:fs/promises";

const startedAt = Date.now();
const activity = [{ at: new Date().toISOString(), level: "ok", message: "Dashboard control center initialized" }];
let lastTelegramState = null;
let lastJobState = null;

function percent(used, total) {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
}

function addActivity(message, level = "info") {
  activity.unshift({ at: new Date().toISOString(), level, message });
  activity.splice(40);
}

async function diskUsage(target = process.cwd()) {
  try {
    const disk = await statfs(target);
    const total = Number(disk.blocks * disk.bsize);
    const free = Number(disk.bavail * disk.bsize);
    return { percent: percent(total - free, total), used: total - free, total };
  } catch {
    return { percent: 0, used: 0, total: 0 };
  }
}

function bytes(value) {
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / 1024 ** index).toFixed(index > 2 ? 1 : 0) + " " + units[index];
}

export async function getDashboardSnapshot({ getTelegramState = () => "unknown", getRuntimeSnapshot = () => ({}) } = {}) {
  const telegram = getTelegramState();
  const runtime = getRuntimeSnapshot() || {};
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const cpu = Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100));
  const disk = await diskUsage();
  const jobState = runtime.activeJobs > 0 ? "busy" : "ready";

  if (lastTelegramState !== null && lastTelegramState !== telegram) addActivity("Telegram changed to " + telegram, telegram === "running" ? "ok" : "warn");
  if (lastJobState !== null && lastJobState !== jobState) addActivity(jobState === "busy" ? "Codex job started" : "Codex queue is ready", jobState === "busy" ? "info" : "ok");
  lastTelegramState = telegram;
  lastJobState = jobState;

  return {
    service: "ashraf-ai-assistant",
    status: telegram === "running" ? "operational" : "degraded",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    system: {
      cpu: { percent: cpu, load: os.loadavg()[0].toFixed(2) },
      memory: { percent: percent(totalMemory - freeMemory, totalMemory), used: bytes(totalMemory - freeMemory), total: bytes(totalMemory) },
      disk: { percent: disk.percent, used: bytes(disk.used), total: bytes(disk.total) },
    },
    agents: [
      { name: "Telegram Poller", role: "Message gateway", status: telegram === "running" ? "online" : telegram, accent: "cyan" },
      { name: "Codex Worker", role: "Serial AI jobs", status: jobState, accent: "violet" },
      { name: "Memory Core", role: "Persistent JSON", status: "online", accent: "green" },
      { name: "Document Watch", role: "Group file monitor", status: "standby", accent: "amber" },
    ],
    runtime: { activeJobs: runtime.activeJobs || 0, lastSuccess: runtime.lastSuccess || null },
    activity,
  };
}

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASHRAF AI — Control Center</title>
<style>
:root{color-scheme:dark;--bg:#070b17;--panel:#0d1426cc;--line:#1d2b48;--text:#e8f1ff;--muted:#7f91ad;--cyan:#22d3ee;--violet:#a78bfa;--green:#34d399;--amber:#fbbf24;--danger:#fb7185}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% -10%,#172554 0,transparent 35%),radial-gradient(circle at -10% 70%,#18213f 0,transparent 30%),var(--bg);font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--text)}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(#ffffff05 1px,transparent 1px),linear-gradient(90deg,#ffffff05 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(to bottom,#0006,transparent)}.shell{max-width:1240px;margin:auto;padding:26px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.brand{display:flex;align-items:center;gap:13px}.logo{width:42px;height:42px;border:1px solid #22d3ee80;border-radius:12px;display:grid;place-items:center;background:#071827;box-shadow:0 0 28px #22d3ee25;color:var(--cyan);font-weight:900}.eyebrow{font-size:11px;letter-spacing:.22em;color:var(--cyan);text-transform:uppercase}.brand h1{font-size:19px;margin:2px 0}.live{display:flex;gap:9px;align-items:center;color:#9fb1ca;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 13px var(--green);animation:pulse 1.7s infinite}@keyframes pulse{50%{opacity:.35}}.hero,.card{border:1px solid var(--line);background:linear-gradient(145deg,#10192ed9,#0a1020d9);box-shadow:0 20px 70px #0005;backdrop-filter:blur(12px)}.hero{padding:24px;border-radius:18px;display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.hero h2{font-size:29px;margin:5px 0}.hero p{margin:0;color:var(--muted)}.badge{padding:9px 13px;border:1px solid #34d39955;border-radius:999px;color:var(--green);background:#34d39910;text-transform:uppercase;font-size:11px;letter-spacing:.12em}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.card{border-radius:16px;padding:18px}.metric-head{display:flex;justify-content:space-between;color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.12em}.metric-value{font-size:28px;font-weight:750;margin:13px 0 8px}.bar{height:6px;background:#ffffff0c;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--violet));box-shadow:0 0 14px var(--cyan);transition:width .55s}.metric-sub{font-size:11px;color:var(--muted);margin-top:8px}.main{display:grid;grid-template-columns:1.25fr .75fr;gap:18px}.title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#afbdd1;margin-bottom:14px}.agents{display:grid;grid-template-columns:repeat(2,1fr);gap:11px}.agent{border:1px solid #1b2944;border-radius:13px;background:#07101f99;padding:15px;display:flex;gap:12px;align-items:center}.agent-icon{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:#101d34;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);font-weight:800}.agent strong{display:block;font-size:13px}.agent small{color:var(--muted)}.state{margin-left:auto;font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--accent)}.log{height:277px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.entry{display:grid;grid-template-columns:64px 8px 1fr;gap:9px;padding:9px 0;border-bottom:1px solid #17223a}.time{color:#60728e}.pin{width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--cyan)}.entry.ok .pin{background:var(--green)}.entry.warn .pin{background:var(--amber)}.empty{color:var(--muted);padding:34px 0;text-align:center}.footer{display:flex;justify-content:space-between;color:#536580;font-size:11px;margin-top:16px}.error{color:var(--danger)}@media(max-width:780px){.shell{padding:16px}.hero{align-items:flex-start;gap:18px}.metrics,.main{grid-template-columns:1fr}.agents{grid-template-columns:1fr}.hero h2{font-size:23px}}
</style></head><body><div class="shell"><header class="top"><div class="brand"><div class="logo">AI</div><div><div class="eyebrow">VPS Operations</div><h1>ASHRAF AI Control Center</h1></div></div><div class="live"><span class="dot"></span><span id="sync">Connecting…</span></div></header><section class="hero"><div><div class="eyebrow">System overview</div><h2>All systems under control.</h2><p>One lightweight process. Telegram, Codex, memory and document monitoring.</p></div><div class="badge" id="overall">Checking</div></section><section class="metrics"><div class="card"><div class="metric-head"><span>CPU load</span><span id="cpuLoad">—</span></div><div class="metric-value" id="cpu">—</div><div class="bar"><i id="cpuBar"></i></div><div class="metric-sub">Normalized across available cores</div></div><div class="card"><div class="metric-head"><span>Memory</span><span id="memoryText">—</span></div><div class="metric-value" id="memory">—</div><div class="bar"><i id="memoryBar"></i></div><div class="metric-sub">Live VPS allocation</div></div><div class="card"><div class="metric-head"><span>Disk</span><span id="diskText">—</span></div><div class="metric-value" id="disk">—</div><div class="bar"><i id="diskBar"></i></div><div class="metric-sub">Current filesystem</div></div></section><main class="main"><section class="card"><div class="title">Agent fleet</div><div class="agents" id="agents"></div><div class="footer"><span id="uptime">Uptime —</span><span id="jobs">0 active jobs</span></div></section><section class="card"><div class="title">Live activity</div><div class="log" id="activity"><div class="empty">Waiting for telemetry…</div></div></section></main></div><script>
const $=function(id){return document.getElementById(id)};const colors={cyan:"#22d3ee",violet:"#a78bfa",green:"#34d399",amber:"#fbbf24"};function duration(s){const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+"d ":"")+(h?h+"h ":"")+m+"m"}function metric(name,data,extra){$(name).textContent=data.percent+"%";$(name+"Bar").style.width=data.percent+"%";if(extra)$(extra).textContent=data.used+" / "+data.total}async function refresh(){try{const r=await fetch("/api/status",{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const d=await r.json();$("overall").textContent=d.status;$("overall").classList.toggle("error",d.status!=="operational");$("sync").textContent="Live · "+new Date(d.generatedAt).toLocaleTimeString();$("cpuLoad").textContent="load "+d.system.cpu.load;metric("cpu",d.system.cpu);metric("memory",d.system.memory,"memoryText");metric("disk",d.system.disk,"diskText");$("uptime").textContent="Uptime "+duration(d.uptimeSeconds);$("jobs").textContent=d.runtime.activeJobs+" active job"+(d.runtime.activeJobs===1?"":"s");$("agents").innerHTML=d.agents.map(function(a){return '<div class="agent" style="--accent:'+colors[a.accent]+'"><div class="agent-icon">'+a.name.split(" ").map(function(x){return x[0]}).join("")+'</div><div><strong>'+a.name+'</strong><small>'+a.role+'</small></div><div class="state">'+a.status+'</div></div>'}).join("");$("activity").innerHTML=d.activity.map(function(a){return '<div class="entry '+a.level+'"><span class="time">'+new Date(a.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})+'</span><span class="pin"></span><span>'+a.message+'</span></div>'}).join("")||'<div class="empty">No activity yet</div>'}catch(e){$("sync").textContent="Telemetry unavailable";$("overall").textContent="offline";$("overall").classList.add("error")}}refresh();setInterval(refresh,3000);
</script></body></html>`;
