import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore {
  constructor(root) {
    this.root = root;
    this.writeQueue = Promise.resolve();
  }

  file(name) {
    if (!/^[a-z0-9-]+\.json$/i.test(name)) throw new Error("Invalid memory filename.");
    return path.join(this.root, name);
  }

  async read(name, fallback = {}) {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    }
  }

  async write(name, value) {
    const operation = async () => {
      await mkdir(this.root, { recursive: true });
      const destination = this.file(name);
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, destination);
      return value;
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  async update(name, fallback, mutate) {
    return this.write(name, await mutate(await this.read(name, fallback)));
  }
}
