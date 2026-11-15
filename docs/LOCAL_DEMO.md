# Laptop demo runbook

Prepared 2026-11-14. This is a procedure for a later integrated, verified demo checkout. The central maintenance branch, capture, platform and editor remain separate; no combined demo or stable release has been created.

## Current local setup

Capture's `.env.local` is the current source. It has been copied to central, platform and editor; platform's previous file is backed up under its ignored `.verify/env-backups/`. All four environment files are ignored and untracked. No destination-only keys were present. The app and test database identities differ, the pinned CA file resolves, and the LiveKit secret and US phone destination pass local format checks. These checks do not prove a LiveKit login or assigned Chert line.

Keep secrets in `.env.local` in each checkout. Copy future updates deliberately and preserve destination-specific additions. `DATABASE_CA_CERT` currently points outside the repo; another laptop or host needs the CA file or the supported PEM value. Never disable TLS verification to replace it. Database application data belongs in `DATABASE_URL`; only the platform test harness uses `TEST_DATABASE_URL`.

| Runtime | Configuration | When needed |
| --- | --- | --- |
| Next server | `DATABASE_URL`, `DATABASE_CA_CERT`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or anon alias), `SUPABASE_SECRET_KEY` (or service-role alias), `SUPABASE_STORAGE_BUCKET` | Authenticated projects, metadata and private storage |
| Server reconstruction | `FAL_API_KEY` or `FAL_KEY` | A deliberately requested paid reconstruction; never browser-side |
| Capture worker | Existing LiveKit/Chert settings from capture's environment | Only after line assignment and an explicitly intended test call |
| Platform tests | Separate `TEST_DATABASE_URL` plus the platform settings | Live conformance tests; they create test records |

Only public Supabase configuration carries the `NEXT_PUBLIC_` prefix. Changing it requires rebuilding Next. Restart processes after any environment change; copying a file does not reconfigure an already-running process.

## Prepare the later demo checkout

After Cody performs integration and selects the demo revision:

1. Confirm `git status --short` is clean and record `git rev-parse HEAD`. Use the intended demo checkout, not a busy lane.
2. On a fresh checkout, run `npm run lane:setup` once. For a resolved dependency-only update, run `npm ci`. The two lanes previously encountered npm dropping optional native packages when editing the lockfile; preserve those entries and confirm `node_modules/@rolldown/binding-win32-x64-msvc` exists on this machine.
3. Ensure the local environment and CA are present. Existing app/test services and the bucket have already been provisioned; do not reprovision them for every demo launch. For a genuinely new environment, the platform's migration/storage commands must be run deliberately there.
4. Run the appropriate integrated verification gates. `npm run verify` covers the app checks and build. The platform suites use the test database and real test users; they are not an offline-only command. Run the capture agent's pytest suite separately if that worker changed.

## Start the web app

In the eventual integrated checkout, use a terminal:

```powershell
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
```

The build/start scripts and options are documented by the installed Next 16.4.6 guides under `node_modules/next/dist/docs/01-app/01-getting-started/17-deploying.md` and `03-api-reference/06-cli/next.md`. This runs the server locally while TigerData, Supabase and fal remain remote services. A Python capture process is separate and unnecessary for the upload-only path.

Open `http://127.0.0.1:3000/login`. First check sign-in and projects, then the eventual upload/editor flow. The current capture lab is development-only and returns 404 in production; it is not the final demo route. Real email delivery has not yet been proven; the platform's prior sign-ins used real admin-issued OTPs, so verify a deliverable account before judging.

## Optional phone/judge access later

For a temporary HTTPS URL, install `cloudflared` from its official distribution and, in another terminal, run:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

Quick Tunnels need no account or domain, generate a temporary public URL, and stop serving when the process stops. They have no uptime guarantee, change hostname on each launch, and do not support SSE. Use normal HTTP polling for jobs in this setup. See [Cloudflare's current Quick Tunnel instructions](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). This procedure has not been activated or tested here.

Open the printed HTTPS URL on the phone. Verify login, project ownership, upload, save/reload and camera permissions on that exact origin; configure auth redirect allowlists if using email-link callbacks. Re-test when the hostname changes. Application authentication still controls projects. Keep the laptop powered, awake and connected. Stop the tunnel and web server with Ctrl+C when finished. A GoDaddy domain is optional and does not itself host the application; a durable domain/tunnel setup can follow later.

## Remaining demo gates

- Shared HTTP backend/byte adapters, bounded reconstruction submission/polling, editor and exports still need integration and full journey testing.
- Saved fal proof is valid on the selected car sample, estimated at $0.025. Reuse its local artifacts for inspection; never submit another job just to reload a preview. Actual balance is visible in the fal dashboard, not established by the CLI estimate.
- The generated mesh is about 11 MB / 563k triangles, and scale/axes are uncalibrated. Confirm dimensions and device performance before presenting it as a measured object.
- Chert still needs an assigned line and an actual caller-frame proof. Starting the web server does not start a call or establish that proof.
- Stop at a verified demo rehearsal; stable promotion remains Cody's separate decision.
