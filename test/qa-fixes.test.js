// Cases from the independent QA run: each was a false positive or a miss before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, looksLikeRealSecret } from '../src/scan.js';

const errors = r => r.issues.filter(i => i.level === 'error').map(i => i.name).sort();

test('writes, comments and strings are not reads', () => {
  const r = analyze([
    { path: 'a.js', content: "process.env.JS_WRITE = 'v';\n// process.env.COMMENTED_OUT\n/* process.env.BLOCK */\nconst s = \"process.env.IN_STRING\";\nprocess.env.JS_REAL;\nconst t = `${process.env.IN_TEMPLATE}`;" },
    { path: 'b.rb', content: "ENV[\"RB_WRITE\"] = \"x\"\nENV['RB_OR'] ||= 'y'\n# ENV['RB_COMMENT']\nputs \"#{ENV['RB_INTERP']}\"" },
    { path: 'c.py', content: "# os.environ['PY_COMMENT']\nos.environ['PY_WRITE'] = '1'\n'''\nos.environ['PY_DOC']\n'''\nprint(f\"{os.environ['PY_FSTR']}\")" },
  ]);
  assert.deepEqual(errors(r), ['IN_TEMPLATE', 'JS_REAL', 'PY_FSTR', 'RB_INTERP']);
});

test('defaults and optional checks in every language are not errors', () => {
  const r = analyze([
    { path: 'a.rb', content: 'ENV.fetch("RB_BLOCK") { 5 }\nENV.fetch("RB_DO") do 5 end\nif ENV["RB_FLAG"].present?\nENV["RB_EQ"] == "true"\nunless ENV["RB_UNLESS"]' },
    { path: 'b.kt', content: 'val x = System.getenv("KT_VAR") ?: "d"' },
    { path: 'c.cs', content: 'var x = Environment.GetEnvironmentVariable("CS_VAR") ?? "d";' },
    { path: 'd.exs', content: 'System.get_env("EX_VAR", "d")\nSystem.get_env("EX_OR") || "x"' },
    { path: 'e.rs', content: 'env::var("RS_VAR").unwrap_or("d".into());\nenv::var("RS_DEF").unwrap_or_default();' },
    { path: 'f.py', content: 'os.environ.get("PY_OR") or "d"' },
    { path: 'g.js', content: "if (process.env.JS_FLAG) {}\nconst y = process.env.JS_EQ === 'true';\nconst z = !process.env.JS_NOT;" },
    { path: 'h.java', content: 'System.getenv().getOrDefault("JAVA_DEF", "d")' },
  ]);
  assert.deepEqual(errors(r), []);
  assert.ok(!r.issues.some(i => i.level === 'warn'), JSON.stringify(r.issues.filter(i => i.level === 'warn')));
});

test('multi-line destructuring with a comment, bracket import.meta.env', () => {
  const r = analyze([{ path: 'a.ts', content: "const {\n  ML_A, // c\n  ML_B\n} = process.env;\nimport.meta.env['VITE_BRACKET'];" }]);
  assert.deepEqual(errors(r), ['ML_A', 'ML_B', 'VITE_BRACKET']);
});

test('Dockerfile continuation lines and quoted values', () => {
  const r = analyze([
    { path: 'Dockerfile', content: 'ENV FIRST=1 \\\n    SECOND_ML=2\nENV APP_B="x=y z=w"' },
    { path: 'a.js', content: 'process.env.SECOND_ML; process.env.APP_B; process.env.x; process.env.z' },
  ]);
  assert.deepEqual(errors(r), ['x', 'z']);
});

test('public-by-design keys and settings about secrets are not "exposed"', () => {
  const names = ['NEXT_PUBLIC_FIREBASE_API_KEY', 'NEXT_PUBLIC_ALGOLIA_SEARCH_API_KEY', 'NEXT_PUBLIC_MAPBOX_TOKEN', 'VITE_AUTH_TOKEN_EXPIRY'];
  const r = analyze([{ path: 'a.js', content: names.map(n => `process.env.${n}`).join(';') + ';process.env.PUBLIC_DATABASE_URL' }]);
  assert.deepEqual(r.issues.filter(i => i.type === 'exposed').map(i => i.name), ['PUBLIC_DATABASE_URL']);
});

test('local URLs in example files are not secrets; PWD-style names are', () => {
  assert.equal(looksLikeRealSecret('DATABASE_URL', 'mysql://root:root@localhost:3306/taxonomy?schema=public'), false);
  assert.equal(looksLikeRealSecret('DATABASE_URL', 'postgres://app:s3cretpassword@db:5432/app'), false);
  assert.equal(looksLikeRealSecret('DATABASE_URL', 'postgres://app:Xk29fja81kd@prod.db.acme-corp.net/app'), true);
  assert.equal(looksLikeRealSecret('PLAIN_PWD', 'hunter2hunter2hunter2hunter2'), true);
});

test('app variables with CI-like prefixes are checked; proxies are platform', () => {
  const r = analyze([{ path: 'a.js', content: 'process.env.GITHUB_CLIENT_SECRET; process.env.RENDERER_URL; process.env.GITHUB_SHA; process.env.http_proxy' }]);
  assert.deepEqual(errors(r), ['GITHUB_CLIENT_SECRET', 'RENDERER_URL']);
});

test('compose env_file in a hidden folder counts as definitions', () => {
  const r = analyze([
    { path: 'docker-compose.yml', content: 'services:\n  web:\n    env_file: ./.envs/.production/.django\n' },
    { path: '.envs/.production/.django', content: 'DJANGO_SECRET_KEY=abc\n' },
    { path: 'settings.py', content: 'env("DJANGO_SECRET_KEY")' },
  ]);
  assert.deepEqual(r.issues.filter(i => i.level !== 'info'), []);
});

test('commented-out example entries document optional variables; library vars are not "unused"', () => {
  const r = analyze([
    { path: '.env.example', content: '# OPT_FEATURE=on\nTF_VAR_region=x\nFIRESTORE_EMULATOR_HOST=localhost:8080\n' },
    { path: 'a.js', content: 'process.env.OPT_FEATURE' },
  ]);
  assert.deepEqual(r.issues, []);
});

test('large files scan in linear time', () => {
  const big = Array.from({ length: 20000 }, (_, i) => `process.env.V${i % 50};`).join('\n');
  const t = Date.now();
  analyze([{ path: 'big.js', content: big }]);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t}ms`);
});

test('a read guarded elsewhere in the same file is optional', () => {
  const r = analyze([{ path: 'a.rb', content: "opts[:url] = ENV['CAS_URL'] if ENV['CAS_URL']\nbind ENV['SOCKET_X']" }]);
  assert.deepEqual(errors(r), ['SOCKET_X']);
});

test('presence checks: key?, in, Go if-init, safe navigation', () => {
  const r = analyze([
    { path: 'a.rb', content: "return ENV['URL_PORT'] if ENV.key?('URL_PORT')\nx = ENV['LOCALE_X']&.to_sym" },
    { path: 'b.py', content: "if 'PY_IN' in os.environ:\n    x = os.environ['PY_IN']" },
    { path: 'c.go', content: 'if file := os.Getenv("GO_INIT"); file != "" {}' },
    { path: 'd.js', content: "if ('JS_IN' in process.env) x = process.env.JS_IN" },
  ]);
  assert.deepEqual(errors(r), []);
});
