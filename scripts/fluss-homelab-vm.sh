#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
vm_name="${1:-bench-swarm-01a}"
action="${2:-deploy}"
remote_dir="/home/ubuntu/oss-knowledge-base-fluss-flink"
jump_host="${OSS_KB_HOMELAB_JUMP_HOST:-morefinepublic}"

case "$vm_name" in
  bench-swarm-01a|bench-swarm-02|bench-swarm-03) ;;
  *)
    echo "unsupported benchmark VM: $vm_name" >&2
    exit 2
    ;;
esac

case "$action" in
  deploy|validate|status|logs|stop) ;;
  *)
    echo "usage: $0 [bench-swarm-01a|bench-swarm-02|bench-swarm-03] {deploy|validate|status|logs|stop}" >&2
    exit 2
    ;;
esac

# Resolve through the jump host so this also works off the home LAN. The ARP
# source fails on this libvirt host ("wrong nlmsg len"); DHCP leases do not.
vm_ip="$(
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$jump_host" \
    "sudo -n virsh domifaddr '$vm_name' --source lease" \
    | sed -n '/ipv4/ s/.*ipv4[[:space:]]*\([^[:space:]]*\).*/\1/p' \
    | cut -d/ -f1 | head -n1
)"
if [[ ! "$vm_ip" =~ ^192\.168\.122\.[0-9]+$ ]]; then
  echo "unexpected $vm_name address: $vm_ip" >&2
  exit 1
fi

ssh_args=(-J "$jump_host" -o BatchMode=yes -o ConnectTimeout=10 "ubuntu@$vm_ip")
rsync_ssh="ssh -J $jump_host -o BatchMode=yes -o ConnectTimeout=10"

if [[ "$action" == "deploy" ]]; then
  ssh "${ssh_args[@]}" "mkdir -p '$remote_dir'"
  rsync -az \
    --exclude=.git \
    --exclude=.agents \
    --exclude=node_modules \
    --exclude=target \
    --exclude=apps/web/dist \
    -e "$rsync_ssh" \
    "$repo_root/" "ubuntu@$vm_ip:$remote_dir/"
fi

ssh "${ssh_args[@]}" "cd '$remote_dir' && DEPLOYMENT_TARGET='$vm_name' bash spikes/fluss-flink-compat/homelab/run.sh '$action'"

if [[ "$action" == "deploy" || "$action" == "validate" ]]; then
  local_evidence_dir="$repo_root/spikes/fluss-flink-compat/homelab/evidence"
  mkdir -p "$local_evidence_dir"
  rsync -az \
    -e "$rsync_ssh" \
    "ubuntu@$vm_ip:$remote_dir/spikes/fluss-flink-compat/homelab/evidence/" \
    "$local_evidence_dir/"
fi
