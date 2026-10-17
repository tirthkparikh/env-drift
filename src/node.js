// Node-side helpers: read a project from disk, check GitHub, print the report.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { analyze, fileKind, normalPath, composeEnvFiles } from './scan.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.vercel', '.netlify',
  'coverage', '.nyc_output', 'vendor', 'venv', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', 'target', 'obj', '.gradle', '.idea', '.vscode', '.cache', 'tmp', '.terraform', 'storybook-static']);

/** Read every relevant file under root. Returns [{ path, content }] with forward-slash relative paths. */
export async function readProject(root, { exclude = [], maxFiles = 20000, maxBytes = 1_000_000 } = {}) {
  const files = [];
  exclude = exclude.map(p => (p.startsWith('*.') ? p : normalPath(p)));
  const excluded = rel => exclude.some(p => rel === p || rel.startsWith(p.replace(/\/?$/, '/')) || (p.startsWith('*.') && rel.endsWith(p.slice(1))));
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (excluded(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) && !(e.name === '.github')) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        await walk(full);
      } else if (e.isFile() && fileKind(rel)) {
        try {
          const s = await stat(full);
          if (s.size > maxBytes) continue;
          files.push({ path: rel, content: await readFile(full, 'utf8') });
        } catch {}
      }
    }
  }
  await walk(root);
  // compose env_file entries often live in hidden folders (.envs/.production/.django) that the walk skips
  const have = new Set(files.map(f => f.path));
  for (const f of files.filter(f => fileKind(f.path) === 'compose')) {
    for (const rel of composeEnvFiles(f.path, f.content)) {
      if (have.has(rel) || rel.startsWith('..') || excluded(rel)) continue;
      try {
        const full = join(root, rel);
        if ((await stat(full)).size > maxBytes) continue;
        files.push({ path: rel, content: await readFile(full, 'utf8') });
        have.add(rel);
      } catch {}
    }
  }
  return files;
}

export async function scanProject(root, opts = {}) {
  const files = await readProject(root, opts);
  return analyze(files, opts);
}

/** Compare the secrets/variables workflows need with what the GitHub repo has. */
export async function checkGitHub(report, repo, token, api = process.env.GITHUB_API_URL || 'https://api.github.com') {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'env-drift' };
  const names = async (path, key) => {
    const all = [];
    for (let page = 1; page < 20; page++) {
      const res = await fetch(`${api}/repos/${repo}/${path}?per_page=100&page=${page}`, { headers });
      if (res.status === 404 || res.status === 403) return { error: res.status };
      if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
      const data = await res.json();
      all.push(...(data[key] ?? []).map(s => s.name));
      if ((data[key] ?? []).length < 100) break;
    }
    return { names: all };
  };
  const [secrets, orgSecrets, variables, orgVariables] = await Promise.all([
    names('actions/secrets', 'secrets'), names('actions/organization-secrets', 'secrets'),
    names('actions/variables', 'variables'), names('actions/organization-variables', 'variables'),
  ]);
  if (secrets.error) throw new Error(`Can't list secrets for ${repo} (HTTP ${secrets.error}). The token needs "Secrets: read" on that repo.`);
  const haveS = new Set([...(secrets.names ?? []), ...(orgSecrets.names ?? [])]);
  const haveV = new Set([...(variables.names ?? []), ...(orgVariables.names ?? [])]);
  for (const s of report.ci.secrets) {
    if (!haveS.has(s)) report.issues.unshift({ level: 'error', type: 'ci-secret-missing', name: s, message: `workflow uses secrets.${s}, but ${repo} has no such secret`, where: report.ciWhere[s] ?? [] });
  }
  for (const v of report.ci.variables) {
    if (!variables.error && !haveV.has(v)) report.issues.unshift({ level: 'error', type: 'ci-variable-missing', name: v, message: `workflow uses vars.${v}, but ${repo} has no such variable`, where: report.ciWhere[v] ?? [] });
  }
  report.counts = { error: report.issues.filter(i => i.level === 'error').length, warn: report.issues.filter(i => i.level === 'warn').length, info: report.issues.filter(i => i.level === 'info').length };
  report.github = { repo, secrets: haveS.size, variables: haveV.size };
  return report;
}

const TITLES = {
  missing: 'Missing: read by the app, but not set or documented anywhere',
  exposed: 'Exposed to the browser',
  'secret-in-example': 'Real-looking secret in an example file',
  'missing-soft': 'Possibly missing: read without a default, not set anywhere',
  'ci-secret-missing': 'GitHub Actions secret missing',
  'ci-variable-missing': 'GitHub Actions variable missing',
  undocumented: 'Not in the example file',
  empty: 'Empty but required',
  'env-file-missing': 'env_file not found',
  'missing-optional': 'Has a default, but not documented',
  unused: 'Unused: set or documented, but nothing reads it',
};

export function formatReport(report, { color = true, verbose = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const icon = { error: c(31, '✖'), warn: c(33, '!'), info: c(90, '·') };
  const lines = [`${c(1, 'env-drift')}  ${c(90, `scanned ${report.scanned} files · ${report.variables} variables${report.github ? ` · GitHub ${report.github.repo}` : ''}`)}`, ''];
  const groups = new Map();
  for (const i of report.issues) {
    if (i.level === 'info' && !verbose && i.type !== 'unused') continue;
    if (!groups.has(i.type)) groups.set(i.type, []);
    groups.get(i.type).push(i);
  }
  const order = Object.keys(TITLES);
  for (const type of [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    const items = groups.get(type);
    lines.push(`${icon[items[0].level]} ${c(1, TITLES[type] ?? type)}`);
    const width = Math.min(34, Math.max(...items.map(i => i.name.length)) + 2);
    for (const i of items) {
      const where = i.where.slice(0, 3).join(', ') + (i.where.length > 3 ? ` +${i.where.length - 3} more` : '');
      lines.push(i.name.length + 2 > width ? `  ${i.name}\n  ${" ".repeat(width)}${c(90, where)}` : `  ${i.name.padEnd(width)}${c(90, where)}`);
      if (verbose || ['exposed', 'secret-in-example', 'ci-secret-missing', 'empty', 'env-file-missing'].includes(type)) lines.push(`  ${' '.repeat(width)}${c(90, i.message)}`);
    }
    lines.push('');
  }
  if (report.ci.secrets.length || report.ci.variables.length) {
    lines.push(`${icon.info} ${c(1, 'GitHub Actions needs')}`);
    if (report.ci.secrets.length) lines.push(`  secrets:   ${report.ci.secrets.join(', ')}`);
    if (report.ci.variables.length) lines.push(`  variables: ${report.ci.variables.join(', ')}`);
    if (!report.github) lines.push(c(90, '  check them against the repo with --github owner/repo (uses GITHUB_TOKEN)'));
    lines.push('');
  }
  if (report.dynamic.length && verbose) lines.push(c(90, `Dynamic access (process.env[name]) in ${report.dynamic.join(', ')}: those can't be checked.`), '');
  if (!report.exampleFiles.length) lines.push(c(90, 'No .env.example found. Run with --fix to create one.'), '');
  const { error, warn } = report.counts;
  const notes = report.issues.filter(i => i.level === 'info').length;
  lines.push(error || warn ? `${error ? c(31, `${error} error${error === 1 ? '' : 's'}`) : '0 errors'}, ${warn ? c(33, `${warn} warning${warn === 1 ? '' : 's'}`) : '0 warnings'}, ${notes} note${notes === 1 ? '' : 's'}` : c(32, `✔ No drift found${notes ? ` (${notes} note${notes === 1 ? '' : 's'})` : ''}`));
  return lines.join('\n');
}
