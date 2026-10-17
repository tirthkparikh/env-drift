# env-drift

[![npm](https://img.shields.io/npm/v/@tirthlabs/env-drift?color=c2410c)](https://www.npmjs.com/package/@tirthlabs/env-drift) [![CI](https://github.com/tirthkparikh/env-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/tirthkparikh/env-drift/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@tirthlabs/env-drift)](LICENSE) · [Live demo](https://tirthparikh.com/tools/env-drift/)

**Find environment variables that are missing, undocumented, unused or leaking, before a deploy does.**

```bash
npx @tirthlabs/env-drift
```

```text
env-drift  scanned 214 files · 31 variables

✖ Missing: read by the app, but not set or documented anywhere
  SENTRY_DSN                   docker-compose.yml:7, src/server.ts:5
  VITE_STRIPE_PUBLISHABLE_KEY  web/config.ts:3

✖ Exposed to the browser
  VITE_STRIPE_SECRET_KEY  web/config.ts:2, .env:7
                          the VITE_ prefix bundles this into browser code, but the name says it's a secret

✖ Real-looking secret in an example file
  STRIPE_SECRET_KEY  .env.example:3

! Not in the example file
  REDIS_URL  api/settings.py:6, set in .env:3

· Unused: set or documented, but nothing reads it
  OLD_ANALYTICS_ID  .env:5

· GitHub Actions needs
  secrets:   DOCKERHUB_TOKEN, SSH_KEY
  variables: DEPLOY_HOST

3 errors, 1 warning, 1 note
```

Most tools only compare `.env` with `.env.example`. env-drift reads **everything that touches configuration** and cross-checks it:

| Source | What it reads |
| --- | --- |
| Code | JS/TS (`process.env`, `import.meta.env`, destructuring, Deno, Bun), Python (`os.environ`, `os.getenv`, django-environ, python-decouple), Go, Ruby, PHP/Laravel, Rust, Java/Kotlin, C#, Elixir |
| `.env*` files | `.env`, `.env.local`, `.env.production`… plus `.env.example` / `.sample` / `.template` as documentation |
| Docker | `Dockerfile` `ENV` / `ARG`; `docker compose` `environment`, `env_file`, `${VAR:-default}` interpolation |
| GitHub Actions | `env:` blocks, `${{ secrets.X }}` and `${{ vars.X }}` |
| Kubernetes | container `env`, `ConfigMap` and `Secret` keys, `envFrom` |
| Next.js | `env` in `next.config.*` |

Defaults are understood: `process.env.PORT || 3000`, `os.getenv('X', 'y')`, `${TAG:-latest}` and `env.bool('DEBUG', default=False)` don't make a variable "required". OS, CI and hosting variables (`NODE_ENV`, `GITHUB_*`, `VERCEL_*`, `PORT` defaults…) are ignored.

## Checks

| Level | Check |
| --- | --- |
| ✖ error | **Missing**: required by code or compose, but set nowhere and not in the example file |
| ✖ error | **Exposed**: `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`… prefix on a secret-looking name (publishable and anon keys are fine) |
| ✖ error | **Secret in example**: real-looking keys (`sk_live_`, `ghp_`, `AKIA…`, JWTs, private keys, URLs with passwords) in a committed example file |
| ✖ error | **CI secret missing**: with `--github owner/repo`, workflow secrets and variables the repo doesn't have |
| ! warning | **Not in the example file**: required, set locally, but teammates and servers won't know about it |
| ! warning | **Empty**: required but blank in `.env` |
| ! warning | **Possibly missing**: read without a default (e.g. `os.environ.get`) and set nowhere |
| · note | **Unused**: in `.env` or the example file, but nothing reads it |

## CI

```yaml
# .github/workflows/env.yml
name: env-drift
on: [pull_request]
jobs:
  env:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @tirthlabs/env-drift --ci
        # add --github ${{ github.repository }} with a token that can read secrets to check those too
```

`--ci` exits with 1 on errors. Add `--strict` to fail on warnings too.

## Options

```text
env-drift [dir]
  --ci                    exit 1 when there are errors
  --strict                with --ci, warnings fail too
  --fix                   append missing/undocumented variables to .env.example (creates it if needed)
  --github <owner/repo>   check workflow secrets/variables exist (GITHUB_TOKEN with secrets:read)
  --ignore <A,B,SENTRY_*> skip variables (wildcards at the end)
  --exclude <path,…>      skip folders or files
  --json                  machine-readable report
  --verbose               explanations and notes
```

`.envdriftrc.json` in the project root:

```json
{ "ignore": ["SENTRY_*", "LEGACY_FLAG"], "exclude": ["examples/", "docs/"] }
```

## From code

The analyser is a pure function over file contents, so it also runs in the browser:

```js
import { analyze } from '@tirthlabs/env-drift/scan';
const report = analyze([{ path: 'src/app.ts', content: '…' }, { path: '.env.example', content: '…' }]);
```

```js
import { scanProject, formatReport } from '@tirthlabs/env-drift';
console.log(formatReport(await scanProject('.'), { color: false }));
```

## License

MIT © Tirth Parikh, [tirthparikh.com](https://tirthparikh.com)
