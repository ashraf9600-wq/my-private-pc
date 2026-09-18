import path from "node:path";
import { appendConversation } from "./memory/conversation.mjs";
import { detectProjectCommand, addProject, listProjects, updateProject } from "./memory/projects.mjs";
import { extractMemoryCommand, isSensitiveMemory, saveFact } from "./memory/profile.mjs";
import { retrieveRelevantMemory } from "./memory/retrieve.mjs";
import { JsonStore } from "./memory/store.mjs";
import { rphInstructions } from "./rph/generator.mjs";
import { detectRphIntent } from "./rph/intent.mjs";
import { detectRphStateCommand, parseProgressMemory, savePlannedRph, setRphProgress, updateLatestRphState } from "./rph/progress.mjs";

export const HELP_TEXT = `🤖 ASHRAF AI

📚 RPH
“Buat RPH minggu depan”

🗓 Jadual
“Jadual saya esok”

🧠 Memori
“Apa yang awak ingat pasal saya?”

📁 Projek
“Projek saya apa?”

🛠 Bantuan
“Tolong troubleshoot...”

💬 Chat
Tanya apa-apa seperti biasa.`;

function formatProjects(projects) {
  if (!projects.length) return "Bos, belum ada projek yang disimpan.";
  return `Projek bos:\n${projects.map((project, index) => `${index + 1}. ${project.name} — ${project.status}`).join("\n")}`;
}

function formatMemory(profile, facts) {
  const lines = [
    `Nama: ${profile.name}`,
    `Panggilan: ${profile.preferred_address}`,
    `Sekolah: ${profile.school}`,
  ];
  if (facts.length) lines.push("Memori tambahan:", ...facts.map((fact) => `• ${fact.text}`));
  else lines.push("Belum ada memori tambahan yang bos simpan.");
  return lines.join("\n");
}

export function buildPrompt(request, context) {
  const extra = detectRphIntent(request) ? `\nARAHAN RPH:\n${rphInstructions(request)}` : "";
  return `Anda ialah ASHRAF AI, pembantu peribadi Mohamad Ashraf bin Jamaluddin. Jawab dalam Bahasa Melayu Malaysia yang mesra, ringkas dan praktikal. Panggil pengguna “bos” secara semula jadi. Untuk troubleshooting, beri SATU tindakan seterusnya dahulu. Untuk arahan teknikal, utamakan langkah mudah iPad/touchscreen dan arahan yang boleh disalin. Jangan reka memori atau mendakwa akses perkhidmatan luar.\n\nKONTEKS BERKAITAN SAHAJA:\n${JSON.stringify(context)}${extra}\n\nPERMINTAAN BOS:\n${request}`;
}

export function createAssistant({ dataRoot, runTask, workdir, now = () => new Date() }) {
  const store = new JsonStore(path.resolve(dataRoot));

  return async function processMessage(text, { chatId }) {
    const request = text.trim();
    if (request === "/start" || request === "/help") return HELP_TEXT;

    const memoryText = extractMemoryCommand(request);
    if (memoryText) {
      if (isSensitiveMemory(memoryText)) return "Bos, maklumat itu nampak sensitif, jadi saya tak simpan dalam memori.";
      const progress = parseProgressMemory(memoryText);
      if (progress) {
        await setRphProgress(store, progress.className, progress.subject, {
          latest_week: progress.week,
          sk: progress.sk,
          sp: progress.sp,
          completion_status: "taught",
          notes: "Kemajuan disimpan melalui arahan eksplisit bos.",
        }, now());
        return `Baik bos, kemajuan ${progress.subject} ${progress.className} hingga SP ${progress.sp} dah disimpan.`;
      }
      const projectFromMemory = detectProjectCommand(request);
      if (projectFromMemory?.action === "add") {
        const project = await addProject(store, projectFromMemory.name, {}, now());
        return `Baik bos, projek “${project.name}” dah disimpan.`;
      }
      await saveFact(store, memoryText, now());
      return `Baik bos, saya ingat: ${memoryText}`;
    }

    const projectCommand = detectProjectCommand(request);
    if (projectCommand?.action === "list") return formatProjects(await listProjects(store));
    if (projectCommand?.action === "add") {
      if (isSensitiveMemory(projectCommand.name)) return "Bos, maklumat itu nampak sensitif, jadi saya tak simpan.";
      const project = await addProject(store, projectCommand.name, {}, now());
      return `Baik bos, projek “${project.name}” dah ditambah.`;
    }
    if (projectCommand?.action === "complete") {
      const project = await updateProject(store, projectCommand.name, { status: "completed" }, now());
      return project ? `Siap bos. Projek “${project.name}” ditandakan completed.` : "Bos, projek itu belum ada dalam memori.";
    }

    if (/^(?:\/memory|\/profile|apa yang awak (?:ingat|tahu) pasal saya)$/i.test(request)) {
      const [profile, memory] = await Promise.all([
        store.read("profile.json", {}),
        store.read("bot-memory.json", { facts: [] }),
      ]);
      return formatMemory(profile, memory.facts || []);
    }

    const rphState = detectRphStateCommand(request);
    if (rphState) {
      const updated = await updateLatestRphState(store, request, rphState, now());
      if (!updated) return "Bos, saya belum jumpa RPH planned yang sepadan dalam memori.";
      return rphState === "taught"
        ? `Baik bos, RPH ${updated.subject} ${updated.class} ditandakan sudah diajar.`
        : `Baik bos, RPH ${updated.subject} ${updated.class} ditandakan ditangguh.`;
    }

    const context = await retrieveRelevantMemory(store, request, { chatId, now: now() });
    await appendConversation(store, chatId, "user", request, now());
    const response = await runTask(buildPrompt(request, context), { workdir });
    await appendConversation(store, chatId, "assistant", response, now());
    if (detectRphIntent(request)) await savePlannedRph(store, request, response, now());
    return response;
  };
}
