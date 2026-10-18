import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, parseDotenv, looksLikeRealSecret } from '../src/scan.js';
import { scanProject, checkGitHub, formatAnnotations } from '../src/node.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, 'fixtures/app');
const CLI = join(here, '../bin/cli.js');
const run = promisify(execFile);
const byType = (report, type) => report.issues.filter(i => i.type === type).map(i => i.name).sort();

test('dotenv parsing: export, quotes, comments, multi-line', () => {
  const e = parseDotenv('# c\nexport A=1\nB="two words" # note\nC=\'x\'\nD=val # trailing\nKEY="-----BEGIN\nabc\n-----END"\nE=\n');
  assert.deepEqual(e.map(x => [x.name, x.value]), [['A', '1'], ['B', 'two words'], ['C', 'x'], ['D', 'val'], ['KEY', '-----BEGIN\nabc\n-----END'], ['E', '']]);
});

test('secret detection ignores placeholders', () => {
  assert.equal(looksLikeRealSecret('STRIPE_SECRET_KEY', 'sk_' + 'live_51HxAbCdEfGhIjKl'), true);
  assert.equal(looksLikeRealSecret('OPENAI_API_KEY', 'sk-' + 'proj-abcdefghijklmnopqrstuvwx'), true);
  assert.equal(looksLikeRealSecret('DATABASE_URL', 'postgres://admin:Sup3rS3cret!@db.prod.internal/app'), true);
  for (const v of ['', 'changeme', 'your-api-key', '<secret>', 'sk_test_123', 'postgres://user:password@localhost:5432/app', 'false']) {
    assert.equal(looksLikeRealSecret('API_KEY', v), false, v);
  }
});

test('fixture project: every kind of drift is found', async () => {
  const r = await scanProject(APP);
  assert.deepEqual(byType(r, 'missing'), ['SENTRY_DSN', 'SMTP_HOST', 'VITE_STRIPE_PUBLISHABLE_KEY']);
  assert.deepEqual(byType(r, 'missing-soft'), ['OPENAI_API_KEY']);
  assert.deepEqual(byType(r, 'exposed'), ['VITE_STRIPE_SECRET_KEY']);
  assert.deepEqual(byType(r, 'secret-in-example'), ['STRIPE_SECRET_KEY']);
  assert.deepEqual(byType(r, 'empty'), ['DJANGO_SECRET_KEY']);
  assert.deepEqual(byType(r, 'unused'), ['LEGACY_MODE', 'OLD_ANALYTICS_ID']);
  assert.deepEqual(byType(r, 'env-file-missing'), ['worker.env']);
  const undoc = r.issues.filter(i => i.type === 'undocumented');
  assert.deepEqual(undoc.filter(i => i.level === 'warn').map(i => i.name).sort(), ['REDIS_URL', 'VITE_STRIPE_SECRET_KEY']);
  // values that Docker, k8s or Compose provide don't need an .env.example entry
  assert.deepEqual(undoc.filter(i => i.level === 'info').map(i => i.name).sort(), []);
  // never flagged: platform vars, Vite built-ins, fully covered vars
  for (const n of ['NODE_ENV', 'MODE', 'DATABASE_URL', 'GITHUB_TOKEN']) assert.ok(!r.issues.some(i => i.name === n), n);
  assert.deepEqual(r.ci, { secrets: ['DOCKERHUB_TOKEN', 'SSH_KEY'], variables: ['DEPLOY_HOST'] });
  assert.deepEqual(r.dynamic, ['src/server.ts']);
  assert.equal(r.counts.error, 5);
});

test('languages: Go, Ruby, PHP, Rust, Java, C#, Elixir, Deno, Bun', () => {
  const files = [
    { path: 'main.go', content: 'os.Getenv("GO_VAR"); os.LookupEnv("GO_VAR2")' },
    { path: 'app.rb', content: "ENV['RB_VAR']; ENV.fetch('RB_OPT', 'x')" },
    { path: 'index.php', content: "getenv('PHP_VAR'); $_ENV['PHP_VAR2']; env('LARAVEL_VAR', 'default')" },
    { path: 'main.rs', content: 'std::env::var("RS_VAR"); env!("RS_BUILD")' },
    { path: 'App.java', content: 'System.getenv("JAVA_VAR")' },
    { path: 'Program.cs', content: 'Environment.GetEnvironmentVariable("CS_VAR")' },
    { path: 'config.exs', content: 'System.get_env("EX_VAR")' },
    { path: 'mod.ts', content: 'Deno.env.get("APP_DENO_VAR"); Bun.env.BUN_VAR_X' },
  ];
  const r = analyze(files);
  assert.deepEqual(byType(r, 'missing'), ['APP_DENO_VAR', 'CS_VAR', 'EX_VAR', 'GO_VAR', 'JAVA_VAR', 'PHP_VAR', 'PHP_VAR2', 'RB_VAR', 'RS_BUILD', 'RS_VAR'].sort());
  // BUN_ prefix is treated as platform; defaults and LookupEnv (which reports "not set") are not errors
  assert.ok(!r.issues.some(i => i.name === 'GO_VAR2' && i.level === 'error'));
  assert.ok(!r.issues.some(i => i.name === 'RB_OPT' && i.level === 'error'));
  assert.ok(!r.issues.some(i => i.name === 'LARAVEL_VAR' && i.level === 'error'));
});

test('ignore list with wildcard', () => {
  const r = analyze([{ path: 'a.js', content: 'process.env.SENTRY_ORG; process.env.SENTRY_PROJECT; process.env.KEEP' }], { ignore: ['SENTRY_*'] });
  assert.deepEqual(byType(r, 'missing'), ['KEEP']);
});

test('CLI: --ci exit code, --json, --fix writes .env.example', async () => {
  await assert.rejects(run(process.execPath, [CLI, APP, '--ci']), e => e.code === 1 && /5 errors/.test(e.stdout));
  const { stdout } = await run(process.execPath, [CLI, APP, '--json']);
  assert.equal(JSON.parse(stdout).counts.error, 5);

  const dir = await mkdtemp(join(tmpdir(), 'ed-'));
  await cp(APP, dir, { recursive: true });
  await run(process.execPath, [CLI, dir, '--fix']);
  const example = await readFile(join(dir, '.env.example'), 'utf8');
  assert.match(example, /# Added by env-drift/);
  assert.match(example, /^SENTRY_DSN=$/m);
  assert.match(example, /^REDIS_URL=$/m);
  const after = JSON.parse((await run(process.execPath, [CLI, dir, '--json'])).stdout);
  assert.deepEqual(byType(after, 'missing'), []);
  assert.deepEqual(byType(after, 'undocumented'), []);
});

test('--github compares workflow secrets with the repo (mock API)', async () => {
  const server = http.createServer((req, res) => {
    const send = b => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== 'Bearer t0k') { res.writeHead(401); return res.end('{}'); }
    if (req.url.startsWith('/repos/me/app/actions/secrets')) return send({ secrets: [{ name: 'SSH_KEY' }] });
    if (req.url.startsWith('/repos/me/app/actions/organization-secrets')) return send({ secrets: [] });
    if (req.url.startsWith('/repos/me/app/actions/variables')) return send({ variables: [{ name: 'DEPLOY_HOST' }] });
    if (req.url.startsWith('/repos/me/app/actions/organization-variables')) return send({ variables: [] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const r = await scanProject(APP);
    await checkGitHub(r, 'me/app', 't0k', `http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(byType(r, 'ci-secret-missing'), ['DOCKERHUB_TOKEN']);
    assert.deepEqual(byType(r, 'ci-variable-missing'), []);
    assert.equal(r.counts.error, 6);
  } finally { server.close(); }
});

test('annotations: one GitHub workflow command per issue, pinned to the first use', async () => {
  const r = await scanProject(APP);
  const out = formatAnnotations(r, { prefix: 'services/app/' }).split('\n');
  const missing = r.issues.find(i => i.type === 'missing');
  const line = out.find(l => l.includes(`::${missing.name}: `));
  assert.match(line, /^::error file=services\/app\/[^,]+,line=\d+,title=env-drift%3A Missing%3A /);
  assert.ok(out.every(l => /^::(error|warning|notice) /.test(l)));
  assert.equal(out.filter(l => l.startsWith('::error ')).length, r.counts.error);
  // values are escaped so a message can't break out of the command
  const fake = { issues: [{ level: 'warn', type: 'empty', name: 'A', message: 'x\ny, 100%', where: ['a,b.env:3'] }] };
  assert.equal(formatAnnotations(fake), '::warning file=a%2Cb.env,line=3,title=env-drift%3A Empty but required::A: x%0Ay, 100%25');
});

test('CLI prints annotations in GitHub Actions only, unless told otherwise', async () => {
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: join(APP, '..') };
  const inCI = (await run(process.execPath, [CLI, APP], { env })).stdout;
  assert.match(inCI, /^::error file=app\//m);
  assert.match(inCI, /errors?, /);
  const off = (await run(process.execPath, [CLI, APP, '--no-annotations'], { env })).stdout;
  assert.doesNotMatch(off, /^::/m);
  const json = (await run(process.execPath, [CLI, APP, '--json'], { env })).stdout;
  assert.doesNotMatch(json, /^::/m);
  const local = { ...process.env }; delete local.GITHUB_ACTIONS;
  assert.doesNotMatch((await run(process.execPath, [CLI, APP], { env: local })).stdout, /^::/m);
  assert.match((await run(process.execPath, [CLI, APP, '--annotations'], { env: local })).stdout, /^::error /m);
});
