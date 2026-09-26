import { mkdir, writeFile, readFile, readdir, rename, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const defaultDataDir = () => resolve(process.env.EFFORT_DATA_DIR || join(homedir(), '.effort-project'));
export class Store {
  constructor(dir = defaultDataDir()) { this.dir = resolve(dir); }
  async initialize() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dir)).isSymbolicLink()) throw new Error('Data directory must not be a symlink.');
    this.dir = await realpath(this.dir);
    return this;
  }
  async save(task) {
    if (!idPattern.test(task.id)) throw new Error('Invalid task ID.');
    const content = JSON.stringify(task, null, 2);
    if (Buffer.byteLength(content) > 512_000) throw new Error('Task record exceeds limit.');
    const temp = join(this.dir, `.${task.id}-${randomUUID()}.tmp`);
    await writeFile(temp, content + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, join(this.dir, `${task.id}.json`));
  }
  async get(id) {
    if (!idPattern.test(id)) throw new Error('Invalid task ID.');
    const path = join(this.dir, `${id}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) throw new Error('Invalid task record.');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async list(limit = 100) {
    const names = (await readdir(this.dir)).filter(n => n.endsWith('.json') && idPattern.test(n.slice(0,-5)));
    const tasks = [];
    for (const name of names.slice(-5000)) {
      try { tasks.push(await this.get(name.slice(0,-5))); } catch { /* one corrupt record must not hide the rest */ }
    }
    return tasks.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  }
}
