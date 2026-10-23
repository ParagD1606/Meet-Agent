#!/usr/bin/env bash
# One-time helper for automatic deploys: makes an SSH key, authorizes it on the VM, tests it, and prints the four values
# to paste into GitHub (repo > Settings > Secrets and variables > Actions). Needs `gcloud` logged in.
#   ./scripts/setup-deploy-key.sh
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-project-a8a3562f-1df6-48a5-b5b}"
ZONE="${GOOGLE_CLOUD_ZONE:-us-central1-a}"
INSTANCE="${GOOGLE_CLOUD_INSTANCE:-vortexa-learnloop}"
REMOTE_USER="${GOOGLE_CLOUD_SSH_USER:-manas}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f "${TMP}/key" -q
PUB="$(cat "${TMP}/key.pub")"

IP="$(gcloud compute instances describe "${INSTANCE}" --project="${PROJECT}" --zone="${ZONE}" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[[ -n "${IP}" ]] || { echo "Could not find the VM's external IP." >&2; exit 1; }
echo "VM address: ${IP}"

echo "Authorizing the key on the VM..."
gcloud compute ssh "${REMOTE_USER}@${INSTANCE}" --project="${PROJECT}" --zone="${ZONE}" --command="
  mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  grep -qF '${PUB}' ~/.ssh/authorized_keys || echo '${PUB}' >> ~/.ssh/authorized_keys"

KNOWN="$(ssh-keyscan -t ed25519 "${IP}" 2>/dev/null)"
[[ -n "${KNOWN}" ]] || { echo "ssh-keyscan got nothing: is port 22 open to the internet on this VM?" >&2; exit 1; }
printf '%s\n' "${KNOWN}" > "${TMP}/known_hosts"

echo "Testing the key like GitHub will use it..."
if ! ssh -i "${TMP}/key" -o BatchMode=yes -o UserKnownHostsFile="${TMP}/known_hosts" -o ConnectTimeout=20 "${REMOTE_USER}@${IP}" 'echo ssh-ok'; then
  echo "The key was added but SSH login failed. If the VM uses OS Login, authorize it with:" >&2
  echo "  gcloud compute os-login ssh-keys add --key-file=<public key>   (or add it as instance metadata)" >&2
  exit 1
fi

cat <<EOF

================ Add these 4 secrets in GitHub ================
DEPLOY_HOST        = ${IP}
DEPLOY_USER        = ${REMOTE_USER}
DEPLOY_KNOWN_HOSTS = (the line below)
${KNOWN}

DEPLOY_SSH_KEY     = (everything between the lines below, including BEGIN and END)
-----------------------------------------------------------------
$(cat "${TMP}/key")
-----------------------------------------------------------------
================================================================
The private key exists only in this terminal output; nothing was saved to disk. Clear your terminal after pasting.
EOF
