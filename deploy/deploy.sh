#!/usr/bin/env bash
# Ship the current main to the server: build the face here, pull the brain there.
#
#   DEPLOY_HOST=ubuntu@140.245.209.140 DEPLOY_DOMAIN=g1.axiosiiitl.dev deploy/deploy.sh
#
# The face is built on this machine and copied over, because `vite build` on a
# 1 GB server that also runs other things is how the OOM killer picks a victim.
# The brain is plain Node and needs no build — just the code and its modules.
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@140.245.209.140}"
: "${DEPLOY_DOMAIN:?set DEPLOY_DOMAIN, e.g. g1.axiosiiitl.dev}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/jarvis}"

cd "$(dirname "$0")/.."

# Hand tracking loads its WebAssembly from our own origin (see scripts/start.mjs),
# so it has to be in public/ before the build copies public/ into dist/.
if [ ! -f public/mediapipe/vision_wasm_internal.wasm ]; then
  mkdir -p public/mediapipe
  cp -R node_modules/@mediapipe/tasks-vision/wasm/. public/mediapipe/
fi

# The client opens its socket at the site root; nginx tells the two apart.
VITE_BRIDGE_URL="wss://${DEPLOY_DOMAIN}" npm run build

rsync -az --delete dist/ "${DEPLOY_HOST}:${DEPLOY_DIR}/dist/"

ssh "${DEPLOY_HOST}" "set -e
  cd ${DEPLOY_DIR}
  git pull --ff-only
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  sudo systemctl restart jarvis-bridge
  sleep 2
  systemctl is-active jarvis-bridge"
