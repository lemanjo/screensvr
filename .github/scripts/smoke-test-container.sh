#!/usr/bin/env bash
set -euo pipefail

container_id=$(docker run --detach --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --publish 127.0.0.1::3000 screensvr:release)
trap 'docker rm --force --volumes "$container_id" >/dev/null' EXIT

[[ "$(docker inspect --format '{{.Config.User}}' "$container_id")" == node ]]
port=$(docker inspect --format \
  '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' "$container_id")

for ((attempt = 0; attempt < 30; attempt++)); do
  if curl --fail --silent --show-error --max-time 2 \
    "http://127.0.0.1:$port/api/health"; then
    exit 0
  fi
  sleep 2
done

docker logs "$container_id"
echo "The production container did not become healthy." >&2
exit 1
