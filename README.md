# Helper Service

常駐 helper API です。Railway でも Google Compute Engine でも動かせます。

## Role Split

- `Supabase`
  - user/session などの状態
  - helper job
  - conversion plan
  - saved problem
- `Railway helper`
  - 計算計画の作成
  - Supabase への plan / job 保存
  - `planId` ベースで Render 実行をオーケストレーション
  - 完了後の `problems` 保存
- `Render` (`iVucx` 本体)
  - Lean / Coq proof check
  - typed-lambda / `cic-v1` の重い変換
  - Supabase から `helper_conversion_plans` を読んで必要な source だけ取得

## Routes

- `GET /healthz`
- `GET /api/helper/info`
- `GET /api/helper/schema-check`
- `POST /api/lean-check`
- `POST /api/coq-check`
- `POST /api/proof-convert`
- `POST /api/helper/check`
- `POST /api/helper/submit`
- `POST /api/helper/convert`
- `GET /api/helper/jobs`
- `GET /api/helper/jobs/:id`
- `GET /api/helper/jobs/:id/result`
- `DELETE /api/helper/jobs/:id`

## Required Env

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- one of:
  - `EXECUTION_SERVER_BASE_URL`
  - or `GITHUB_EXECUTION_ENABLED=true` with GitHub executor settings

Accepted aliases:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Optional:

- `HELPER_API_KEY`
- `HELPER_PUBLIC_BASE_URL`
- `EXECUTION_SERVER_API_KEY`
- `EXECUTION_SERVER_TIMEOUT_MS`
- `EXECUTION_SERVER_CONVERT_ROUTE`
- `EXECUTION_SERVER_LEAN_CHECK_ROUTE`
- `EXECUTION_SERVER_COQ_CHECK_ROUTE`
- `GITHUB_EXECUTION_TOKEN`
- `GITHUB_EXECUTION_REPOSITORY`
- `GITHUB_EXECUTION_WORKFLOW`
- `GITHUB_EXECUTION_REF`
- `GITHUB_EXECUTION_ENABLE_LEAN_CIC`
- `GITHUB_EXECUTION_ENABLE_COQ_CIC`
- `GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS`
- `GITHUB_EXECUTION_SYNC_WAIT_POLL_MS`
- `HELPER_MAX_CODE_BYTES`

## Supabase Schema

Run:

- `supabase/proof_helper.sql`
- `supabase/proof_helper_check.sql`

This now creates:

- `public.problems`
- `public.helper_jobs`
- `public.helper_conversion_plans`

## GitHub Actions Executor

This repository can now replace the old Render execution role with GitHub Actions.

### Repository structure

- `.github/workflows/ivucx-proof-executor.yml`
  - workflow entrypoint for heavy execution
- `scripts/github-execution-worker.mjs`
  - worker that loads a plan from Supabase, runs Lean / Coq / conversion tools, and calls back the helper API
- `app.js`
  - planner, job persistence, GitHub workflow dispatch, callback finalization
- `tools/*.cjs`
  - typed-lambda / `cic-v1` converters used by the workflow worker
- `supabase/proof_helper.sql`
  - durable job / plan / saved problem schema

### Runtime split

- `Vercel`
  - UI and public entrypoint
- `Railway helper`
  - plan creation, Supabase state, GitHub Actions dispatch, callback finalization
- `GitHub Actions`
  - Lean / Coq proof check
  - typed-lambda conversion
  - `cic-v1` conversion

### Additional env for helper

- `HELPER_PUBLIC_BASE_URL`
- `GITHUB_EXECUTION_ENABLED`
- `GITHUB_EXECUTION_TOKEN`
- `GITHUB_EXECUTION_REPOSITORY`
- `GITHUB_EXECUTION_WORKFLOW`
- `GITHUB_EXECUTION_REF`

`GITHUB_EXECUTION_TOKEN` should be able to dispatch workflows in the target repository.

### Required GitHub repository secrets

- `HELPER_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Toolchain notes

- The workflow installs `coq` and a standard Lean toolchain automatically.
- Set `GITHUB_EXECUTION_ENABLE_LEAN_CIC=true` to let the workflow build `lean4export` and advertise Lean `cic-v1` support.
- Set `GITHUB_EXECUTION_ENABLE_COQ_CIC=true` to let the workflow install MetaRocq via `opam` and advertise Coq `cic-v1` support.
- Those flags can live on the helper server; the helper forwards them into `workflow_dispatch` inputs, so a separate GitHub repo variable is optional.
- If those flags stay unset, the helper now reports `typed-lambda-v1` only, so the UI will not promise CIC and then silently fall back.

### Behavior notes

- When GitHub execution is enabled, heavy execution becomes async-first.
- `POST /api/helper/check`, `POST /api/helper/convert`, and `POST /api/helper/submit` dispatch GitHub workflows and return helper jobs.
- The workflow reports back to `POST /api/helper/github-actions/callback`.
- If `helper_conversion_plans` is missing, the helper still cannot provide durable GitHub-dispatched execution because plans are loaded from Supabase.

### Render-compatible execution routes

- `POST /api/lean-check`
- `POST /api/coq-check`
- `POST /api/proof-convert`

These routes let the helper act like the old heavy execution server.

- If `GITHUB_EXECUTION_ENABLED=true`, the helper dispatches GitHub Actions and waits up to `GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS` for completion before replying.
- If GitHub execution is not enabled, the helper can still proxy to `EXECUTION_SERVER_BASE_URL`.
- This makes it possible to point Vercel's `EXECUTION_API_BASE_URL` or `EXECUTION_SERVER_BASE_URL` at the helper service while keeping heavy execution off the Vercel runtime.

## Google Compute Engine

This helper can run on a small always-on Google Compute Engine VM instead of Railway.

Added deployment assets:

- `deploy/gce/compose.yaml`
- `deploy/gce/runtime.env.example`
- `deploy/gce/startup-script.sh`
- `deploy/gce/create-instance.sh`
- `deploy/gce/create-firewall-rule.sh`
- `deploy/gce/README.md`

Recommended GCE shape:

- `e2-micro`
- Ubuntu 22.04 LTS
- static external IP
- Docker on the host

Recommended Vercel pairing:

- `HELPER_API_BASE_URL=http://<gce-ip-or-domain>`
- `HELPER_API_KEY=<same as helper>`
- leave `EXECUTION_API_BASE_URL` unset so Vercel reuses the helper's compatibility routes

## Notes

- Railway helper no longer needs Render or Oracle-server for heavy execution when GitHub Actions is configured.
- Jobs keep progress metadata so the UI can show short real-time status text.
- BlueMode client UI may expose only public values like `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- The helper planner still needs a server-side service-role key and cannot bootstrap that key from browser state.
