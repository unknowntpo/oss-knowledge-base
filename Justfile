set shell := ["bash", "-euo", "pipefail", "-c"]

fluss-homelab-deploy vm="bench-swarm-01a":
  bash scripts/fluss-homelab-vm.sh "{{vm}}" deploy

fluss-homelab-validate vm="bench-swarm-01a":
  bash scripts/fluss-homelab-vm.sh "{{vm}}" validate

fluss-homelab-status vm="bench-swarm-01a":
  bash scripts/fluss-homelab-vm.sh "{{vm}}" status

fluss-homelab-logs vm="bench-swarm-01a":
  bash scripts/fluss-homelab-vm.sh "{{vm}}" logs

fluss-homelab-stop vm="bench-swarm-01a":
  bash scripts/fluss-homelab-vm.sh "{{vm}}" stop
