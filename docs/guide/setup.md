# Setup

## 1. Run it
```sh
cp .env.example .env     # ENCRYPTION_KEY (openssl rand -base64 32), SETUP_TOKEN, MODEL_API_KEY, Slack keys, PUBLIC_URL (https)
docker compose up --build
```
Open `PUBLIC_URL`. The Setup page checks model, embeddings and Slack and offers a ready manifest.

For Google ADC with Vertex AI, set `MODEL_PROVIDER=vertex`, `GOOGLE_VERTEX_PROJECT`, and `GOOGLE_APPLICATION_CREDENTIALS` in `.env`. Keep the ADC JSON out of Git. Start the app with the read-only credential mount: `docker compose -f docker-compose.yml -f docker-compose.vertex.yml up --build`.

### Deploy to the Vortexa Learnloop VM

With `gcloud` authenticated, `.env` configured, and `application_default_credentials.json` in the repository root, run `./scripts/deploy-gce.sh`. It uploads the current working tree, builds the app on the VM, and routes `https://slack.derpx06.live` through Caddy to the app on localhost port 3001. It keeps the VM's existing site on port 3000 and persists Brain's database in `pgdata/`.

In Namecheap, add a CNAME record with host `slack` and target `derpx06.live`. The VM already allows HTTPS. After DNS resolves, Caddy obtains the TLS certificate automatically. Before first Slack sign-in, add `https://slack.derpx06.live/slack/oauth/callback` and `https://slack.derpx06.live/auth/slack/callback` to the Slack app's OAuth redirect URLs, then install the app at `https://slack.derpx06.live/slack/install`. Use the `SETUP_TOKEN` from `.env` for the first owner sign-in.

Vertex runs on the ADC JSON alone: the deploy script drops `MODEL_API_KEY`, `MODEL_BASE_URL`, `MODEL_NAME` and `EMBEDDING_API_KEY` from the server's `.env`, and boot needs only `MODEL_PROVIDER=vertex`, `GOOGLE_VERTEX_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS`. After deploying, the script runs `server/scripts/vertex-probe.ts` inside the container (chat, a multi-step tool call and embeddings). Run it by hand with `docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml exec app bun server/scripts/vertex-probe.ts [model]`. If a model is not served to your project the probe says "publisher model not found"; pick another under Configure > Models.

The image runs in production mode: `PUBLIC_URL` must be `https://`, and boot fails with a list of missing settings otherwise.

### Automatic deploys (GitHub Actions)

`.github/workflows/ci-cd.yml` runs type-checks, the web build and the full test suite (against a pgvector Postgres) on pull requests and manual runs. A push to `main` deploys immediately, without waiting for the tests, through `scripts/ci-deploy.sh` (to gate deploys on the tests again, see the comment at the top of the workflow): it uploads only the code, rebuilds the containers on the VM, waits for `/healthz`, runs the live Vertex probe, and rolls back to the previous image if any step fails. `.env` and `application_default_credentials.json` are never uploaded; they stay on the VM from the first `./scripts/deploy-gce.sh`, so GitHub needs only SSH access.

One-time setup:
1. `ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ./deploy_key` and authorize `deploy_key.pub` for `manas` on the VM (`~/.ssh/authorized_keys`; with OS Login enabled use `gcloud compute os-login ssh-keys add --key-file=deploy_key.pub` instead).
2. Repo > Settings > Secrets and variables > Actions, add `DEPLOY_HOST` (VM IP or hostname), `DEPLOY_USER` (`manas`), `DEPLOY_SSH_KEY` (contents of `deploy_key`) and `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 <host>`). Delete the local `deploy_key` files afterwards.
3. Optional: Settings > Environments > `production` > required reviewers, to approve each deploy.

Run `./scripts/ci-deploy.sh` by hand with the same variables to test the connection. Use `./scripts/deploy-gce.sh` only when `.env` or the credentials file changes.

Key env vars (full list in `.env.example`): `DATABASE_URL`, `PUBLIC_URL`, `ENCRYPTION_KEY` (encrypts every stored token; losing it invalidates them), `SETUP_TOKEN` (claims ownership, see step 3), either `MODEL_API_KEY` or Vertex ADC settings (`MODEL_PROVIDER=vertex`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_VERTEX_PROJECT`), `EMBEDDING_*` (dimension is fixed per database), `SLACK_MODE` (`socket` or `http`), `SLACK_TEAM_ID` (optional workspace pin), `SEARCH_PROVIDER` + `SEARCH_API_KEY` (optional web search).

## 2. Create or update the Slack app

For the live deployment, use the existing **Company Brain** app in the Slack API dashboard: **Your Apps → Company Brain → App Manifest → Edit**. Replace the manifest with `docs/slack-app-manifest.yaml` and save it. If creating the app for the first time, choose **Create New App → From a manifest** and paste the same file.

Under **OAuth & Permissions → Redirect URLs**, make sure both exact URLs are listed:

- `https://slack.derpx06.live/slack/oauth/callback`
- `https://slack.derpx06.live/auth/slack/callback`

This deployment uses Socket Mode. Keep the Event Subscriptions and Interactivity **Request URL** fields empty; the manifest enables the events and interactive actions through Socket Mode. In **Basic Information**, check the existing Client ID and Client Secret match `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in the server environment. In **Socket Mode**, keep an app-level token with the `connections:write` scope configured as `SLACK_APP_TOKEN`. Do not paste tokens or secrets into the manifest.

If Slack asks you to reinstall the app after saving changes, use **Install App → Reinstall to Workspace**. Scopes and events are maintained in `server/src/slack/manifest.ts`; `server/src/routes/manifest.ts` generates the runtime manifest, and `server/test/mcp/manifest-yaml.test.ts` checks that the checked-in scopes and events stay in sync.

- **Socket mode** (default): create an app-level token with `connections:write` and set `SLACK_APP_TOKEN`; no public request URL is needed.
- **HTTP mode**: set `SLACK_SIGNING_SECRET`; `PUBLIC_URL` must be reachable by Slack.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, then open `PUBLIC_URL/slack/install` to install. The bot creates or adopts `#company-brain`, syncs users and channels, and sends a welcome message.

## 3. First sign-in
The first person to sign in with Slack becomes **owner**, but only after claiming the server with the setup token: open `PUBLIC_URL/auth/slack?setup_token=<SETUP_TOKEN>` and sign in. Set `SETUP_TOKEN` before first boot; in production, retrieve it from the private `.env` file because the app does not print it to logs. Everyone after is a **member**. Owners promote members to admin under Configure.

## 4. Check
Setup > checks shows database, queue, model, embeddings and Slack status. Send the bot a DM; the Turns page shows the run.
