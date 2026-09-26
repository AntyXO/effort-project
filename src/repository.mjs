import { readdir, lstat } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { performance } from 'node:perf_hooks';

const skip = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'build', 'dist', '.next', 'target', '.effort']);
export async function repositoryFacts(cwd, prompt = '') {
  const root = resolve(cwd);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
  const start = performance.now();
  const languages = new Set(); let files = 0, mentionedFiles = 0, hasTests = false, truncated = false;
  async function walk(dir, depth) {
    if (files >= 500 || performance.now() - start > 50) { truncated = true; return; }
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (files >= 500 || performance.now() - start > 50) { truncated = true; break; }
      if (e.name.startsWith('.') || skip.has(e.name) || e.isSymbolicLink()) continue;
      const path = resolve(dir, e.name);
      if (e.isDirectory() && depth < 2) { await walk(path, depth + 1); continue; }
      if (!e.isFile()) continue;
      files++;
      const extension = extname(e.name).toLowerCase();
      const lang = ({'.js':'javascript','.mjs':'javascript','.ts':'typescript','.tsx':'typescript','.py':'python','.swift':'swift','.rs':'rust','.go':'go','.java':'java','.cpp':'cpp','.c':'c'})[extension];
      if (lang) languages.add(lang);
      if (/test|spec/i.test(relative(root, path))) hasTests = true;
      if (prompt.includes(e.name)) mentionedFiles++;
    }
  }
  await walk(root, 0);
  return { languages: [...languages].sort(), scannedFiles: files, mentionedFiles, hasTests, truncated };
}
