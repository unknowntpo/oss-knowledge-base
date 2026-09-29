#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
action="${1:-deploy}"

case "$action" in
  deploy)
    mkdir -p evidence
    docker compose up -d --build zookeeper coordinator-server tablet-server jobmanager taskmanager
    docker compose restart taskmanager
    docker compose --profile validation run --rm --build validator
    docker compose ps
    ;;
  validate)
    mkdir -p evidence
    docker compose restart taskmanager
    docker compose --profile validation run --rm --build validator
    ;;
  status)
    docker compose ps
    ;;
  logs)
    docker compose logs --no-color --tail=200
    ;;
  stop)
    docker compose stop
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "usage: $0 {deploy|validate|status|logs|stop|down}" >&2
    exit 2
    ;;
esac
