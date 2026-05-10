# Google Compute Engine Deployment

This folder prepares the helper service to run on a small always-on Compute Engine VM while GitHub Actions keeps handling heavy proof execution.

## Files

- `compose.yaml`
  - runs the helper as a Docker container and exposes it publicly
- `runtime.env.example`
  - template for the VM runtime environment
- `startup-script.sh`
  - idempotent VM startup script that installs Docker, clones the repo, writes the env file from instance metadata, and starts the helper
- `install-node20.sh`
  - installs Node.js 20 in user space without sudo
- `start-node.sh`
  - starts the helper directly with Node.js in user space
- `sync-node.sh`
  - fast-forwards the VM checkout to the configured GitHub remote, runs `npm install` if needed, and restarts the helper
- `reclone-node.sh`
  - creates a fresh clone, preserves `.env.runtime`, installs dependencies, swaps the app directory, and restarts the helper
- `stop-node.sh`
  - stops the user-space helper process
- `status-node.sh`
  - prints pid, port, and `/healthz` output for the user-space helper process
- `reserve-static-ip.sh`
  - example `gcloud` wrapper for reserving a static external IP
- `reserve-static-ip.ps1`
  - PowerShell variant for reserving a static external IP on Windows
- `create-instance.sh`
  - example `gcloud` wrapper for creating the VM
- `create-instance.ps1`
  - PowerShell variant for creating the VM on Windows
- `create-firewall-rule.sh`
  - example `gcloud` wrapper for opening inbound HTTP
- `create-firewall-rule.ps1`
  - PowerShell variant for opening inbound HTTP on Windows
- `enable-cron-sync.sh`
  - installs a user crontab entry that runs `sync-node.sh` on a schedule

## Recommended topology

- `Vercel`
  - serves the public app
  - proxies helper and execution requests to the GCE helper
- `Compute Engine`
  - runs this helper container permanently
  - owns the public URL used by `HELPER_API_BASE_URL`
  - can expose `/healthz` for simple VM or load balancer health checks
- `GitHub Actions`
  - runs Lean / Coq proof checks
  - runs typed-lambda conversion
  - runs `cic-v1` conversion when the extra exporter dependencies are present

## Minimal VM shape

- machine type: `e2-micro` to start
- boot disk: `20GB`
- image: `ubuntu-2204-lts`
- external static IP: recommended

## Runtime env

Copy `runtime.env.example` to `.env.runtime` or `runtime.env` and fill in:

- `HELPER_API_KEY`
- `HELPER_PUBLIC_BASE_URL`
- `HELPER_ALLOWED_ORIGINS`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HELPER_MEMORY_SCHEMA_FALLBACK=true` allows conversion/submit responses without persistent Supabase storage.
- `GITHUB_EXECUTION_TOKEN`
- `GITHUB_EXECUTION_REPOSITORY`
- `GITHUB_EXECUTION_ENABLE_LEAN_CIC` if you want Lean `cic-v1`
- `GITHUB_EXECUTION_ENABLE_COQ_CIC` if you want Coq `cic-v1`
- `GCE_SYNC_REPO_URL`
- `GCE_SYNC_REPO_REF`

Do not commit the runtime env file. The repository ignores `deploy/gce/.env.runtime` and `deploy/gce/runtime.env`.

## Direct Node.js mode

If the VM does not have Docker or sudo access, you can run the helper directly with Node.js.

1. Install Node.js `20.x` in user space:

```bash
./deploy/gce/install-node20.sh
```

2. Run `npm install` in the repo root.
3. Copy `runtime.env.example` to `.env.runtime` and fill the real values.
   - set `HELPER_PUBLIC_BASE_URL=http://<vm-ip>:3000`
   - open the VM firewall for `tcp:3000`
4. Start the helper:

```bash
./deploy/gce/start-node.sh
```

5. Check status:

```bash
./deploy/gce/status-node.sh
```

It prints pid, node version, `/healthz`, and config warnings for any missing runtime values.

6. Stop it:

```bash
./deploy/gce/stop-node.sh
```

7. Optionally enable restart on VM reboot:

```bash
./deploy/gce/enable-cron-autostart.sh
```

8. Optionally enable automatic GitHub sync every 5 minutes:

```bash
./deploy/gce/enable-cron-sync.sh
```

This uses `deploy/gce/sync-node.sh`, which:

- tracks `GCE_SYNC_REMOTE` / `GCE_SYNC_REPO_URL` / `GCE_SYNC_REPO_REF`
- fast-forwards the local checkout when possible
- runs `npm install` when dependencies changed
- restarts the helper automatically

If the VM checkout is too stale or points at the wrong remote, run a fresh clone while preserving the runtime env:

```bash
./deploy/gce/reclone-node.sh
```

## Create flow

1. Reserve a static external IP for the VM.
2. Create a firewall rule for inbound `tcp:3000`.
3. Create the VM with `create-instance.sh`.
4. Point `HELPER_PUBLIC_BASE_URL` at the VM URL.
5. Set Vercel env:
   - `HELPER_API_BASE_URL=http://<vm-ip-or-domain>:3000`
   - `HELPER_API_KEY=<same value as helper>`
   - leave `EXECUTION_API_BASE_URL` unset if you want Vercel to reuse the helper's compatibility routes

If your existing VM does not have the `ivucx-helper` network tag yet, either add that tag first or create the firewall rule with an empty target tag so the rule applies without tag filtering.

## Metadata contract

The startup script reads these instance metadata keys:

- `ivucx-helper-repo-url`
- `ivucx-helper-repo-ref`
- `ivucx-helper-env`

`ivucx-helper-env` should contain the full `.env` file contents.

## Windows-first example

From PowerShell:

```powershell
Copy-Item deploy\gce\runtime.env.example deploy\gce\.env.runtime
```

Fill `deploy\gce\.env.runtime`, then run:

```powershell
.\deploy\gce\reserve-static-ip.ps1 -ProjectId YOUR_PROJECT -Region asia-northeast1
.\deploy\gce\create-firewall-rule.ps1 -ProjectId YOUR_PROJECT -Ports tcp:3000 -TargetTag ""
.\deploy\gce\create-instance.ps1 -ProjectId YOUR_PROJECT -Zone asia-northeast1-a -InstanceName ivucx-helper -StaticIp ivucx-helper-ip
```

After the VM boots, point Vercel at:

```text
HELPER_API_BASE_URL=http://YOUR_STATIC_IP:3000
HELPER_API_KEY=<same value as helper>
```
