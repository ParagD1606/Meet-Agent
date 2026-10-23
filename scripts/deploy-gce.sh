#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${GOOGLE_CLOUD_PROJECT:-project-a8a3562f-1df6-48a5-b5b}"
ZONE="${GOOGLE_CLOUD_ZONE:-us-central1-a}"
INSTANCE="${GOOGLE_CLOUD_INSTANCE:-vortexa-learnloop}"
REMOTE_USER="${GOOGLE_CLOUD_SSH_USER:-manas}"
REMOTE_DIR="/home/${REMOTE_USER}/brain-deploy"
VM="${REMOTE_USER}@${INSTANCE}"
DOMAIN="slack.derpx06.live"

ENV_FILE="${ROOT_DIR}/.env"
ADC_FILE="${ROOT_DIR}/application_default_credentials.json"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; configure the app environment first." >&2
  exit 1
fi
if [[ ! -f "${ADC_FILE}" ]]; then
  echo "Missing ${ADC_FILE}; copy the working Google ADC file into the repo root first." >&2
  exit 1
fi

python3 - "${ENV_FILE}" <<'PY'
from pathlib import Path
import sys

values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key.strip()] = value.split("#", 1)[0].strip().strip("'\"")

required = ["ENCRYPTION_KEY", "SETUP_TOKEN", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_APP_TOKEN", "GOOGLE_VERTEX_PROJECT"]
missing = [key for key in required if not values.get(key)]
if missing:
    print("Missing required .env settings: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
if values.get("MODEL_PROVIDER") != "vertex":
    print("This deployment expects MODEL_PROVIDER=vertex.", file=sys.stderr)
    sys.exit(1)
if values.get("SLACK_MODE", "socket") != "socket":
    print("This deployment expects SLACK_MODE=socket.", file=sys.stderr)
    sys.exit(1)
PY

TMP_DIR="$(mktemp -d)"
ARCHIVE="${TMP_DIR}/brain-deploy.tar.gz"
REMOTE_ENV="${TMP_DIR}/.env"
trap 'rm -rf "${TMP_DIR}"' EXIT

cp "${ENV_FILE}" "${REMOTE_ENV}"
python3 - "${REMOTE_ENV}" "${DOMAIN}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
domain = sys.argv[2]
updates = {
    "PUBLIC_URL": f"https://{domain}",
    "APP_PORT": "3001",
    "POSTGRES_PORT": "5433",
}
# Vertex runs on the ADC JSON only: leftover API keys / base URLs must not leak into the server env.
drop = {"MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_NAME", "EMBEDDING_API_KEY", "EMBEDDING_BASE_URL"}
lines = path.read_text().splitlines()
seen = set()
output = []
for line in lines:
    stripped = line.lstrip()
    key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else None
    if key in drop:
        continue
    if key in updates:
        if key not in seen:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
        continue
    output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
path.write_text("\n".join(output) + "\n")
path.chmod(0o600)
PY

chmod 600 "${ADC_FILE}"
tar -czf "${ARCHIVE}" \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.aws' \
  --exclude='./application_default_credentials.json' \
  --exclude='*/application_default_credentials.json' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./web/dist' \
  --exclude='./pgdata' \
  --exclude='./graphify-out' \
  -C "${ROOT_DIR}" .

echo "Preparing ${VM} (${PROJECT}/${ZONE})..."
gcloud compute ssh "${VM}" --project="${PROJECT}" --zone="${ZONE}" \
  --command="mkdir -p '${REMOTE_DIR}'"
gcloud compute scp "${ARCHIVE}" "${VM}:${REMOTE_DIR}/brain-deploy.tar.gz" \
  --project="${PROJECT}" --zone="${ZONE}"
gcloud compute scp "${REMOTE_ENV}" "${VM}:${REMOTE_DIR}/.env" \
  --project="${PROJECT}" --zone="${ZONE}"
gcloud compute scp "${ADC_FILE}" "${VM}:${REMOTE_DIR}/application_default_credentials.json" \
  --project="${PROJECT}" --zone="${ZONE}"

gcloud compute ssh "${VM}" --project="${PROJECT}" --zone="${ZONE}" --command="bash -s" <<'REMOTE'
set -euo pipefail
cd /home/manas/brain-deploy
chmod 600 .env application_default_credentials.json
tar -xzf brain-deploy.tar.gz
docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml up --build -d
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3001/healthz >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml logs --tail=100 app
    exit 1
  fi
  sleep 2
done

# Live Vertex check with the ADC JSON (chat, a multi-step tool call, embeddings). Loud but non-fatal.
docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml exec -T app bun server/scripts/vertex-probe.ts \
  || echo "WARNING: Vertex probe failed; check model access and the ADC file (see logs above)"

if ! sudo grep -Fq 'slack.derpx06.live {' /etc/caddy/Caddyfile; then
  sudo tee -a /etc/caddy/Caddyfile >/dev/null <<'CADDY'

# Brain Slack app, kept separate from the existing LearnLoop site.
slack.derpx06.live {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3001
}
CADDY
fi
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml ps
REMOTE

echo "Deployment is running. Health check: http://127.0.0.1:3001/healthz on the VM."
echo "Public HTTPS becomes available after DNS resolves ${DOMAIN} to this VM."
