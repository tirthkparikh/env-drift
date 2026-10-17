// Environment variable drift: compare what code reads with what .env files, Docker,
// Compose, GitHub Actions and Kubernetes provide. Pure functions over { path, content }
// so the same code runs in Node and in the browser.
import YAML from 'yaml';

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const UPPER = '[A-Z_][A-Z0-9_]*';

// Variables provided by the OS, shells, CI or hosting platforms.
const PLATFORM = [
  /^(PATH|HOME|PWD|OLDPWD|USER|USERNAME|LOGNAME|SHELL|TERM|LANG|LC_\w+|TZ|HOSTNAME|TMPDIR|TEMP|TMP|EDITOR|CI|NODE_ENV|NODE_OPTIONS|NODE_DEBUG|FORCE_COLOR|NO_COLOR|COLORTERM|PYTHONPATH|PYTHONUNBUFFERED|VIRTUAL_ENV|JAVA_HOME|GOPATH|GOROOT|APPDATA|LOCALAPPDATA|USERPROFILE|COMSPEC|SYSTEMROOT|WINDIR|XDG_\w+|DISPLAY|SSH_AUTH_SOCK)$/,
  /^(GITHUB_|RUNNER_|ACTIONS_|GITLAB_|CI_|BITBUCKET_|CIRCLE|TRAVIS|BUILDKITE|JENKINS_|npm_|VERCEL|NEXT_RUNTIME|NETLIFY|RENDER|RAILWAY_|FLY_|HEROKU_|DYNO|AWS_LAMBDA_|AWS_EXECUTION_ENV|LAMBDA_TASK_ROOT|K_SERVICE|K_REVISION|FUNCTION_TARGET|KUBERNETES_|CF_PAGES|DENO_|BUN_)/,
];
const VITE_BUILTIN = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);
export const isPlatform = name => PLATFORM.some(re => re.test(name));

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|VUE_APP_|STORYBOOK_)/;
const SECRETY = /(SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|SERVICE_?ROLE|CLIENT_?SECRET|WEBHOOK_?SECRET|DATABASE_URL|DB_URL|CREDENTIALS)/;
// Keys that are meant to be public even though they contain "KEY"
const PUBLIC_OK = /(PUBLISHABLE|PUBLIC_?KEY|ANON_?KEY|SITE_?KEY|MEASUREMENT_ID|_DSN$)/;

const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro|py|go|rb|php|rs|java|kt|kts|scala|cs|ex|exs)$/;

export const fileKind = path => {
  const base = path.split('/').pop();
  const lower = base.toLowerCase();
  if (/^\.env(\..+)?$/.test(base) || /^(.+\.)?env\.(example|sample|template|dist|defaults|local)$/i.test(base) || lower === 'example.env') return 'dotenv';
  if (/^(docker-)?compose([.-].+)?\.ya?ml$/.test(lower)) return 'compose';
  if (/^dockerfile(\..+)?$/.test(lower) || lower.endsWith('.dockerfile')) return 'dockerfile';
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'actions';
  if (/\.ya?ml$/.test(lower)) return 'yaml';
  if (CODE_EXT.test(lower)) return 'code';
  return null;
};

export const isExample = path => /\.(example|sample|template|dist|defaults)$/i.test(path) || /(^|\/)example\.env$/i.test(path) || /(^|\/)\.env\.(example|sample|template)\./i.test(path);

const lineAt = (text, index) => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

// ---------- code ----------

const CODE_PATTERNS = [
  // [regex, languages, optional-if-default-follows]
  { re: new RegExp(`process\\.env\\.(${NAME})`, 'g'), js: true },
  { re: new RegExp(`process\\.env\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g'), js: true },
  { re: new RegExp(`import\\.meta\\.env\\.(${NAME})`, 'g'), js: true, vite: true },
  { re: new RegExp(`Deno\\.env\\.get\\(\\s*['"](${NAME})['"]`, 'g'), js: true },
  { re: new RegExp(`Bun\\.env\\.(${NAME})`, 'g'), js: true },
  { re: new RegExp(`os\\.environ\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'), py: true, required: true },
  { re: new RegExp(`os\\.environ\\.get\\(\\s*['"](${NAME})['"]\\s*(,)?`, 'g'), py: true, defaultGroup: 2, soft: true },
  { re: new RegExp(`os\\.getenv\\(\\s*['"](${NAME})['"]\\s*(,)?`, 'g'), py: true, defaultGroup: 2, soft: true },
  { re: new RegExp(`\\benv(?:\\.(?:str|bool|int|float|list|dict|json|url|db|db_url|cache|cache_url|email|email_url|search_url|path|tuple|decimal))?\\(\\s*['"](${UPPER})['"]\\s*(,\\s*default\\s*=|,)?`, 'g'), py: true, php: true, defaultGroup: 2 },
  { re: new RegExp(`\\bconfig\\(\\s*['"](${UPPER})['"]\\s*(,\\s*default\\s*=)?`, 'g'), py: true, defaultGroup: 2 },
  { re: new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"(${NAME})"`, 'g'), go: true },
  { re: new RegExp(`ENV\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'), rb: true },
  { re: new RegExp(`ENV\\.fetch\\(\\s*['"](${NAME})['"]\\s*(,)?`, 'g'), rb: true, defaultGroup: 2 },
  { re: new RegExp(`getenv\\(\\s*['"](${NAME})['"]`, 'g'), php: true },
  { re: new RegExp(`\\$_(?:ENV|SERVER)\\[\\s*['"](${UPPER})['"]\\s*\\]`, 'g'), php: true },
  { re: new RegExp(`env::var(?:_os)?\\(\\s*"(${NAME})"`, 'g'), rs: true },
  { re: new RegExp(`(?:std::)?env!\\(\\s*"(${NAME})"`, 'g'), rs: true, required: true },
  { re: new RegExp(`System\\.getenv\\(\\s*"(${NAME})"`, 'g'), jvm: true },
  { re: new RegExp(`Environment\\.GetEnvironmentVariable\\(\\s*"(${NAME})"`, 'g'), cs: true },
  { re: new RegExp(`System\\.(?:get_env|fetch_env!?)\\(\\s*"(${NAME})"`, 'g'), ex: true },
];
const LANG_OF = path => {
  if (/\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro)$/.test(path)) return 'js';
  if (/\.py$/.test(path)) return 'py';
  if (/\.go$/.test(path)) return 'go';
  if (/\.rb$/.test(path)) return 'rb';
  if (/\.php$/.test(path)) return 'php';
  if (/\.rs$/.test(path)) return 'rs';
  if (/\.(java|kt|kts|scala)$/.test(path)) return 'jvm';
  if (/\.cs$/.test(path)) return 'cs';
  if (/\.exs?$/.test(path)) return 'ex';
  return null;
};

function scanCode(path, text, out) {
  const lang = LANG_OF(path);
  if (!lang) return;
  for (const p of CODE_PATTERNS) {
    if (!p[lang]) continue;
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const name = m[1];
      if (p.vite && VITE_BUILTIN.has(name)) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
      const hasDefault = p.required ? false : p.defaultGroup ? !!m[p.defaultGroup] : /^\s*(\|\||\?\?|or\b)/.test(after);
      out.use(name, { file: path, line: lineAt(text, m.index), kind: 'code', optional: hasDefault, soft: !!p.soft && !hasDefault });
    }
  }
  if (lang === 'js' && /(^|\/)next\.config\.[cm]?[jt]s$/.test(path)) {
    const m = text.match(/\benv\s*:\s*\{/);
    if (m) {
      let depth = 0, i = m.index + m[0].length - 1, body = '';
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
        else if (depth === 1) body += ch;
      }
      // keys at the top level of the env object: `key: value` or shorthand `key,`
      const flat = body.replace(/\([^()]*\)|\[[^\[\]]*\]|'[^']*'|"[^"]*"|`[^`]*`/g, '');
      for (const km of flat.matchAll(new RegExp(`(?:^|,)\\s*(?:['"]?)(${NAME})(?:['"]?)\\s*(?=[:,]|$)`, 'g'))) {
        out.define(km[1], { file: path, line: lineAt(text, m.index), kind: 'next-config' });
      }
    }
  }
  if (lang === 'js') {
    const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)\b/g;
    let m;
    while ((m = destr.exec(text))) {
      for (const part of m[1].split(',')) {
        const pm = part.trim().match(new RegExp(`^(${NAME})(\\s*:\\s*${NAME})?(\\s*=)?`));
        if (pm && !VITE_BUILTIN.has(pm[1])) out.use(pm[1], { file: path, line: lineAt(text, m.index), kind: 'code', optional: !!pm[3] });
      }
    }
    if (/process\.env\[\s*(?!['"`])[^\]]/.test(text) || /import\.meta\.env\[\s*(?!['"`])/.test(text)) out.dynamic(path);
  }
  if (lang === 'py' && /os\.environ\[\s*(?!['"])\w/.test(text)) out.dynamic(path);
}

// ---------- dotenv ----------

export function parseDotenv(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=\\s*(.*)$`));
    if (!m) continue;
    let value = m[2];
    if (/^["']/.test(value)) {
      const q = value[0];
      let v = value.slice(1);
      // multi-line quoted values
      while (!v.includes(q) && i + 1 < lines.length) v += '\n' + lines[++i];
      value = v.slice(0, v.indexOf(q) >= 0 ? v.indexOf(q) : undefined);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    entries.push({ name: m[1], value, line: i + 1 - (value.split('\n').length - 1) });
  }
  return entries;
}

const LOOKS_SECRET = [
  /^sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/, /^gh[pousr]_[A-Za-z0-9]{20,}/, /^github_pat_/, /^xox[abprs]-/, /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{30,}/, /^npm_[A-Za-z0-9]{30,}/, /^(sk|rk)_live_[A-Za-z0-9]{10,}/, /^whsec_[A-Za-z0-9]{10,}/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY/, /^[a-z]+:\/\/[^:@/\s]+:[^@/\s]{6,}@/,
];
const PLACEHOLDER = /^(|changeme|change-me|change_me|xxx+|your[-_ ].*|<.*>|\.\.\.|todo|none|null|example|test|dummy|placeholder|secret|password|sk_test_.*|pk_test_.*|localhost.*|http:\/\/localhost.*|postgres(ql)?:\/\/(postgres|user|username):(postgres|password|pass)@.*|redis:\/\/localhost.*|true|false|\d+)$/i;
const PLACEHOLDER_WORDS = /(replace[-_ ]?me|change[-_ ]?me|changeit|your[-_]|example|xxxx|placeholder|dummy|fake|<[^>]+>|\{\{)/i;
export function looksLikeRealSecret(name, value) {
  if (!value || PLACEHOLDER.test(value) || PLACEHOLDER_WORDS.test(value)) return false;
  if (LOOKS_SECRET.some(re => re.test(value))) return true;
  // long random-looking values in secret-named keys
  return SECRETY.test(name) && !PUBLIC_OK.test(name) && value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value) && !/\s/.test(value) && !/^https?:\/\//.test(value);
}

// ---------- YAML-based sources ----------

const INTERP = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
function interpolations(str) {
  const out = [];
  let m;
  INTERP.lastIndex = 0;
  while ((m = INTERP.exec(str))) {
    if (str[m.index - 1] === '$') continue;  // $$ escape
    const name = m[1] ?? m[4];
    out.push({ name, optional: m[2] === '-' || m[2] === ':-' || m[2] === '+' || m[2] === ':+' });
  }
  return out;
}

function walkStrings(node, fn, path = []) {
  if (typeof node === 'string') fn(node, path);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, fn, [...path, i]));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkStrings(v, fn, [...path, k]);
}

function findLine(text, needle) {
  const i = text.indexOf(needle);
  return i < 0 ? undefined : lineAt(text, i);
}

function parseYamlDocs(text) {
  try {
    return YAML.parseAllDocuments(text).map(d => d.toJS({ maxAliasCount: 100 })).filter(Boolean);
  } catch { return null; }
}

function scanCompose(path, text, out) {
  const docs = parseYamlDocs(text);
  if (!docs) return out.skip(path, 'not valid YAML');
  for (const doc of docs) {
    walkStrings(doc, s => {
      for (const it of interpolations(s)) out.use(it.name, { file: path, line: findLine(text, s.length < 200 ? s : it.name), kind: 'compose', optional: it.optional });
    });
    for (const [svc, def] of Object.entries(doc.services ?? {})) {
      const env = def?.environment;
      const entries = Array.isArray(env)
        ? env.map(e => { const [k, ...v] = String(e).split('='); return [k.trim(), v.length ? v.join('=') : null]; })
        : Object.entries(env ?? {});
      for (const [k, v] of entries) {
        if (!new RegExp(`^${NAME}$`).test(k)) continue;
        if (v === null || v === undefined) out.use(k, { file: path, line: findLine(text, k), kind: 'compose-passthrough', service: svc });
        else if (new RegExp(`^\\$\\{?${k}\\}?$`).test(String(v).trim())) continue;  // X=${X} just passes the host value through
        else out.define(k, { file: path, line: findLine(text, k), kind: 'compose', service: svc });
      }
      for (const f of [].concat(def?.env_file ?? [])) out.envFile(typeof f === 'string' ? f : f?.path, path);
    }
  }
}

function scanDockerfile(path, text, out) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    let m = line.match(/^\s*ENV\s+(.+)$/i);
    if (m) {
      const body = m[1].trim();
      const pairs = body.includes('=') ? [...body.matchAll(new RegExp(`(${NAME})=`, 'g'))].map(x => x[1]) : [body.split(/\s+/)[0]];
      for (const k of pairs) out.define(k, { file: path, line: i + 1, kind: 'dockerfile' });
    }
    m = line.match(new RegExp(`^\\s*ARG\\s+(${NAME})`, 'i'));
    if (m) out.define(m[1], { file: path, line: i + 1, kind: 'dockerfile-arg' });
  });
}

function scanActions(path, text, out) {
  const docs = parseYamlDocs(text);
  if (!docs) return out.skip(path, 'not valid YAML');
  const doc = docs[0] ?? {};
  const defineEnv = env => { for (const k of Object.keys(env ?? {})) out.define(k, { file: path, line: findLine(text, `${k}:`), kind: 'actions' }); };
  defineEnv(doc.env);
  for (const job of Object.values(doc.jobs ?? {})) {
    defineEnv(job?.env);
    for (const step of job?.steps ?? []) defineEnv(step?.env);
  }
  const re = /\$\{\{\s*(secrets|vars|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === 'env') continue;
    if (m[1] === 'secrets' && m[2] === 'GITHUB_TOKEN') continue;
    out.ci(m[1] === 'secrets' ? 'secret' : 'variable', m[2], { file: path, line: lineAt(text, m.index) });
  }
}

function scanYaml(path, text, out) {
  if (!/\b(kind|apiVersion)\s*:/.test(text) && !/\benv\s*:/.test(text)) return;
  const docs = parseYamlDocs(text);
  if (!docs) return;  // e.g. Helm templates
  for (const doc of docs) {
    const isK8s = doc && typeof doc === 'object' && 'kind' in doc;
    if (!isK8s) continue;
    if ((doc.kind === 'ConfigMap' || doc.kind === 'Secret')) {
      for (const k of Object.keys({ ...(doc.data ?? {}), ...(doc.stringData ?? {}) })) {
        if (new RegExp(`^${NAME}$`).test(k)) out.define(k, { file: path, line: findLine(text, `${k}:`), kind: `k8s-${doc.kind.toLowerCase()}` });
      }
    }
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.env) && node.env.every(e => e && typeof e === 'object' && 'name' in e)) {
        for (const e of node.env) out.define(e.name, { file: path, line: findLine(text, `name: ${e.name}`), kind: 'k8s' });
      }
      if (Array.isArray(node.envFrom) && node.envFrom.length) out.envFrom(path);
      Object.values(node).forEach(visit);
    };
    visit(doc);
  }
}

// ---------- analysis ----------

/**
 * Analyse a project. files: [{ path, content }] with paths relative to the project root.
 * opts: { ignore: string[], strict: boolean }
 */
export function analyze(files, opts = {}) {
  const vars = new Map();  // name -> { uses: [], defs: [], examples: [] }
  const get = name => {
    if (!vars.has(name)) vars.set(name, { name, uses: [], defs: [], examples: [], dotenv: [] });
    return vars.get(name);
  };
  const ci = { secret: new Map(), variable: new Map() };
  const dynamic = new Set(), skipped = [], envFromFiles = new Set(), envFileRefs = [];
  const exampleSecrets = [], exampleFiles = [], dotenvFiles = [];
  const out = {
    use: (n, at) => get(n).uses.push(at),
    define: (n, at) => get(n).defs.push(at),
    ci: (type, n, at) => { if (!ci[type].has(n)) ci[type].set(n, []); ci[type].get(n).push(at); },
    dynamic: p => dynamic.add(p),
    skip: (p, why) => skipped.push({ file: p, why }),
    envFrom: p => envFromFiles.add(p),
    envFile: (f, from) => envFileRefs.push({ file: f, from }),
  };

  let scanned = 0;
  for (const { path, content } of files) {
    const kind = fileKind(path);
    if (!kind) continue;
    scanned++;
    if (kind === 'code') scanCode(path, content, out);
    else if (kind === 'dotenv') {
      const example = isExample(path);
      (example ? exampleFiles : dotenvFiles).push(path);
      for (const e of parseDotenv(content)) {
        const v = get(e.name);
        if (example) {
          v.examples.push({ file: path, line: e.line });
          if (looksLikeRealSecret(e.name, e.value)) exampleSecrets.push({ name: e.name, file: path, line: e.line });
        } else {
          v.dotenv.push({ file: path, line: e.line, empty: e.value === '' });
        }
        // .env values can reference other variables: FOO=${BAR}
        for (const it of interpolations(e.value)) out.use(it.name, { file: path, line: e.line, kind: 'dotenv-ref', optional: it.optional });
      }
    } else if (kind === 'compose') scanCompose(path, content, out);
    else if (kind === 'dockerfile') scanDockerfile(path, content, out);
    else if (kind === 'actions') scanActions(path, content, out);
    else if (kind === 'yaml') scanYaml(path, content, out);
  }

  const ignore = new Set(opts.ignore ?? []);
  const ignored = name => ignore.has(name) || [...ignore].some(p => p.endsWith('*') && name.startsWith(p.slice(0, -1)));
  const issues = [];
  const add = (level, type, name, message, where = []) => issues.push({ level, type, name, message, where });
  const fmt = at => `${at.file}${at.line ? `:${at.line}` : ''}`;
  const hasExample = exampleFiles.length > 0;

  for (const v of [...vars.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(v.name)) continue;
    const realUses = v.uses;
    const used = realUses.length > 0;
    const requiredUses = realUses.filter(u => !u.optional);
    const defined = v.defs.length > 0 || v.dotenv.length > 0;
    // next.config `env` values are computed in code, so there is nothing to document
    const documented = v.examples.length > 0 || v.defs.some(d => d.kind === 'next-config');
    const platform = isPlatform(v.name);

    if (used && !platform) {
      if (!defined && !documented) {
        if (requiredUses.length) add(envFromFiles.size || requiredUses.every(u => u.soft) ? 'warn' : 'error', requiredUses.every(u => u.soft) ? 'missing-soft' : 'missing', v.name, `read by the app but not set or documented anywhere${envFromFiles.size ? ' (may come from envFrom in Kubernetes)' : ''}`, requiredUses.map(fmt));
        else if (hasExample || opts.strict) add('info', 'missing-optional', v.name, 'read with a default value, but not documented', realUses.map(fmt));
      } else if (!documented && hasExample) {
        add(requiredUses.length ? 'warn' : 'info', 'undocumented', v.name, `${requiredUses.length ? '' : 'has a default, but is '}not in ${exampleFiles[0]}, so teammates and deploys won't know to set it`, [...realUses.slice(0, 3).map(fmt), ...v.dotenv.map(d => `set in ${fmt(d)}`)]);
      } else if (!documented && !hasExample && v.dotenv.length && requiredUses.length) {
        add('info', 'undocumented', v.name, 'only set in your local .env (there is no .env.example)', requiredUses.slice(0, 3).map(fmt));
      }
      const empty = v.dotenv.filter(d => d.empty);
      if (requiredUses.length && empty.length && empty.length === v.dotenv.length && !v.defs.length) add('warn', 'empty', v.name, 'required, but empty in your .env', empty.map(fmt));
    }

    if (!used && (v.dotenv.length || documented)) {
      const where = [...v.dotenv.map(fmt), ...v.examples.map(fmt)];
      add('info', 'unused', v.name, 'set or documented, but nothing reads it', where);
    }

    if (PUBLIC_PREFIX.test(v.name) && SECRETY.test(v.name.replace(PUBLIC_PREFIX, '')) && !PUBLIC_OK.test(v.name)) {
      add('error', 'exposed', v.name, `the ${v.name.match(PUBLIC_PREFIX)[1]} prefix bundles this into browser code, but the name says it's a secret`, [...realUses, ...v.dotenv, ...v.examples].slice(0, 3).map(fmt));
    }

  }

  for (const s of exampleSecrets) if (!ignored(s.name)) add('error', 'secret-in-example', s.name, 'looks like a real secret in an example file that is usually committed', [fmt(s)]);
  for (const ref of envFileRefs) {
    if (!ref.file) continue;
    const base = ref.from.includes('/') ? ref.from.slice(0, ref.from.lastIndexOf('/') + 1) : '';
    const want = (base + ref.file).replace(/^\.\//, '').replace(/\/\.\//g, '/');
    if (!files.some(f => f.path === want || f.path.endsWith('/' + ref.file.replace(/^\.\//, '')))) add('warn', 'env-file-missing', ref.file, `env_file in ${ref.from} not found (fine if it's created at deploy time)`, [ref.from]);
  }

  const ciNeeds = { secrets: [...ci.secret.keys()].sort(), variables: [...ci.variable.keys()].sort() };
  issues.sort((a, b) => ['error', 'warn', 'info'].indexOf(a.level) - ['error', 'warn', 'info'].indexOf(b.level) || a.name.localeCompare(b.name));

  return {
    scanned,
    variables: vars.size,
    issues,
    counts: { error: issues.filter(i => i.level === 'error').length, warn: issues.filter(i => i.level === 'warn').length, info: issues.filter(i => i.level === 'info').length },
    ci: ciNeeds,
    ciWhere: Object.fromEntries([...ci.secret, ...ci.variable].map(([k, v]) => [k, v.map(fmt)])),
    dynamic: [...dynamic],
    skipped,
    exampleFiles, dotenvFiles,
    vars: [...vars.values()].map(v => ({ name: v.name, used: v.uses.length, defined: v.defs.length + v.dotenv.length, documented: v.examples.length > 0, platform: isPlatform(v.name) })),
  };
}

/** Lines to append to an example file for undocumented/missing variables. */
export function exampleAdditions(report) {
  const wanted = report.issues.filter(i => ['missing', 'missing-soft', 'undocumented', 'missing-optional'].includes(i.type));
  return wanted.map(i => `# used in ${i.where.filter(w => !w.startsWith('set in')).slice(0, 2).join(', ') || 'the app'}\n${i.name}=`).join('\n');
}
