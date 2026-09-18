const STATUSES = new Set(["idea", "planned", "in_progress", "blocked", "completed"]);

export async function listProjects(store) {
  return (await store.read("projects.json", { projects: [] })).projects || [];
}

export async function addProject(store, name, details = {}, now = new Date()) {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Project name is required.");
  let result;
  await store.update("projects.json", { projects: [] }, (data) => {
    data.projects ||= [];
    const existing = data.projects.find(
      (project) => project.name.toLocaleLowerCase("ms-MY") === cleanName.toLocaleLowerCase("ms-MY"),
    );
    result = existing || {
      name: cleanName,
      description: details.description || "",
      status: STATUSES.has(details.status) ? details.status : "idea",
      latest_milestone: details.latest_milestone || "",
      next_action: details.next_action || "",
      updated_at: now.toISOString(),
    };
    if (!existing) data.projects.push(result);
    return data;
  });
  return result;
}

export async function updateProject(store, name, changes, now = new Date()) {
  let updated = null;
  await store.update("projects.json", { projects: [] }, (data) => {
    const projects = data.projects || [];
    const target = /^(?:ini|this)$/i.test(name)
      ? projects.at(-1)
      : projects.find((project) =>
          project.name.toLocaleLowerCase("ms-MY").includes(name.toLocaleLowerCase("ms-MY")),
        );
    if (target) {
      Object.assign(target, changes, { updated_at: now.toISOString() });
      if (!STATUSES.has(target.status)) target.status = "in_progress";
      updated = target;
    }
    return data;
  });
  return updated;
}

export function detectProjectCommand(text) {
  const value = text.trim();
  let match = /^(?:tambah|ingat)\s+projek(?:\s+baru)?(?:\s+saya)?\s+(?:ialah\s+)?(.+)$/i.exec(value);
  if (match) return { action: "add", name: match[1].trim() };
  if (/^(?:projek saya apa|apa projek saya|\/projects)$/i.test(value)) return { action: "list" };
  match = /^tandakan\s+projek\s+(.+?)\s+(?:sebagai\s+)?siap$/i.exec(value);
  if (match) return { action: "complete", name: match[1].trim() };
  return null;
}
