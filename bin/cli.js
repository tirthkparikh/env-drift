#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, appendFile, writeFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, checkGitHub, formatReport } from '../src/node.js';
import { exampleAdditions } from '../src/scan.js';

const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
const HELP = `env-drift ${pkg.version}
Find environment variables that are missing, undocumented, unused or leaking, across
code (JS/TS, Python, Go, Ruby, PHP, Rust, Java, C#, Elixir), .env files, Dockerfile,
docker compose, GitHub Actions and Kubernetes manifests.

Usage
  env-drift [dir]                 Scan a project (default: current folder)

Options
  --ci                    Exit 1 when there are errors (for CI)
  --strict                With --ci, warnings fail too
  --fix                   Add missing/undocumented variables to .env.example
  --github <owner/repo>   Check workflow secrets/variables exist (needs GITHUB_TOKEN)
  --ignore <A,B,PREFIX_*> Variables to skip
  --exclude <path,…>      Folders or files to skip
  --json                  Machine-readable output
  --verbose               Show notes and explanations

Config: .envdriftrc.json  { "ignore": ["SENTRY_*"], "exclude": ["legacy/"] }
Docs: ${pkg.homepage}`;

const fail = m => { console.error(`\x1b[31m✖\x1b[0m ${m}`); process.exit(2); };
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      ci: { type: 'boolean' }, strict: { type: 'boolean' }, fix: { type: 'boolean' }, json: { type: 'boolean' }, verbose: { type: 'boolean' },
      github: { type: 'string' }, ignore: { type: 'string' }, exclude: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) { fail(`${e.message}\nRun env-drift --help`); }
const { values: f, positionals } = parsed;
if (f.help) { console.log(HELP); process.exit(0); }
if (f.version) { console.log(pkg.version); process.exit(0); }

const root = resolve(positionals[0] ?? '.');
try { await access(root); } catch { fail(`Folder not found: ${root}`); }

let rc = {};
try { rc = JSON.parse(await readFile(join(root, '.envdriftrc.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') fail(`.envdriftrc.json: ${e.message}`); }
const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

try {
  const report = await scanProject(root, { ignore: [...(rc.ignore ?? []), ...list(f.ignore)], exclude: [...(rc.exclude ?? []), ...list(f.exclude)], strict: f.strict });
  if (f.github) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) fail('--github needs GITHUB_TOKEN (or GH_TOKEN) in the environment.');
    await checkGitHub(report, f.github, token);
  }
  if (f.fix) {
    const additions = exampleAdditions(report);
    const target = join(root, report.exampleFiles[0] ?? '.env.example');
    if (additions) {
      let existing = '';
      try { existing = await readFile(target, 'utf8'); } catch {}
      if (existing) await appendFile(target, `${existing.endsWith('\n') ? '' : '\n'}\n# Added by env-drift\n${additions}\n`);
      else await writeFile(target, `# Environment variables for this project. Copy to .env and fill in.\n\n${additions}\n`);
      if (!f.json) console.log(`\x1b[32m✔\x1b[0m updated ${target.replace(root + '/', '')}\n`);
      // re-scan so the report reflects the fix
      Object.assign(report, await scanProject(root, { ignore: [...(rc.ignore ?? []), ...list(f.ignore)], exclude: [...(rc.exclude ?? []), ...list(f.exclude)] }));
    } else if (!f.json) console.log('Nothing to add to the example file.\n');
  }
  if (f.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, { color: !!process.stdout.isTTY && !process.env.NO_COLOR, verbose: f.verbose }));
  if (f.ci && (report.counts.error || (f.strict && report.counts.warn))) process.exit(1);
} catch (e) { fail(e.message); }
