#!/usr/bin/env bash
# Deploys the checked-out code to the VM over plain SSH (used by .github/workflows/ci-cd.yml; also runnable by hand).
# Secrets are NOT uploaded: .env and application_default_credentials.json already live in the remote dir and are left alone.
#   DEPLOY_HOST=<vm ip or host> [DEPLOY_USER=manas] [DEPLOY_SSH_KEY_FILE=~/.ssh/key] ./scripts/ci-deploy.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:?set DEPLOY_HOST}"
REMOTE_USER="${DEPLOY_USER:-manas}"
REMOTE_DIR="${DEPLOY_DIR:-/home/${REMOTE_USER}/brain-deploy}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15)
[[ -n "${DEPLOY_SSH_KEY_FILE:-}" ]] && SSH_OPTS+=(-i "${DEPLOY_SSH_KEY_FILE}")
TARGET="${REMOTE_USER}@${HOST}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
ARCHIVE="${TMP_DIR}/brain-deploy.tar.gz"
tar -czf "${ARCHIVE}" \
  --exclude='./.git' --exclude='./.github' --exclude='./.env' --exclude='./.aws' \
  --exclude='./application_default_credentials.json' --exclude='*/application_default_credentials.json' \
  --exclude='./node_modules' --exclude='*/node_modules' --exclude='./web/dist' \
  --exclude='./pgdata' --exclude='./graphify-out' \
  -C "${ROOT_DIR}" .

echo "Uploading $(du -h "${ARCHIVE}" | cut -f1) to ${TARGET}:${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p '${REMOTE_DIR}'"
scp "${SSH_OPTS[@]}" "${ARCHIVE}" "${TARGET}:${REMOTE_DIR}/brain-deploy.tar.gz"

ssh "${SSH_OPTS[@]}" "${TARGET}" "REMOTE_DIR='${REMOTE_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"
for f in .env application_default_credentials.json; do
  [ -f "$f" ] || { echo "missing ${REMOTE_DIR}/${f}: run ./scripts/deploy-gce.sh once from a machine that has it" >&2; exit 1; }
done
tar -xzf brain-deploy.tar.gz && rm -f brain-deploy.tar.gz
DC="docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml"
PORT="$(grep -E '^APP_PORT=' .env | tail -1 | cut -d= -f2 || true)"; PORT="${PORT:-3001}"

# keep the running image so a bad release can be rolled back
PREV="$(docker image inspect brain-app:latest --format '{{.Id}}' 2>/dev/null || true)"
[ -n "$PREV" ] && docker tag brain-app:latest brain-app:previous

rollback() {
  echo "Deploy failed; app logs:" >&2
  $DC logs --tail=80 app >&2 || true
  if [ -n "$PREV" ]; then
    echo "Rolling back to the previous image" >&2
    docker tag brain-app:previous brain-app:latest && $DC up -d --no-build >&2 || true
  fi
  exit 1
}

$DC up --build -d || rollback
for i in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null && break
  [ "$i" -eq 60 ] && rollback
  sleep 2
done
# real Vertex check with the ADC JSON: chat, a multi-step tool call, embeddings
$DC exec -T app bun server/scripts/vertex-probe.ts || rollback
docker image prune -f >/dev/null 2>&1 || true
$DC ps
echo "Deployed."
REMOTE
