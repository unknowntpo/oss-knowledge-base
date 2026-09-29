# Fluss/Flink homelab deployment

This directory deploys the pinned compatibility baseline as a real standalone
Flink session cluster next to Fluss on one disposable homelab VM. It does not
publish to R2 or replace the production TypeScript materializer.

## Services

- ZooKeeper 3.9.2
- Fluss 0.9.1-incubating coordinator and tablet server
- Flink 1.20.3 JobManager and TaskManager with the released Fluss connector
- an isolated validator that submits the accepted bounded slice through the
  JobManager REST endpoint and writes evidence to `evidence/`

The 2 GiB TaskManager uses one slot, a 512 MiB task off-heap budget for the
Fluss Arrow writer, and bounded 256 MiB managed / 64 MiB network pools.
Validation restarts only the TaskManager first, giving each bounded proof a
clean direct-memory boundary while leaving Fluss state and the JobManager
session intact.

The only host port is Flink REST on loopback (`127.0.0.1:8081`). No persistent
ingress, DNS, firewall, Cloudflare, or k0s changes are required.

## Benchmark VM flow

Use the infrastructure repository to inspect and start `bench-swarm-01a`:

```bash
cd /Users/unknowntpo/repo/unknowntpo/infra/master
just vm-list
just vm-start bench-swarm-01a
just vm-ip bench-swarm-01a
```

The repository-local wrapper resolves the VM address from libvirt DHCP leases
on the `morefinepublic` SSH jump host, copies the checkout through that host
without deleting prior evidence, and runs the deployment. The VM needs Docker
with the Compose plugin (`sudo apt-get install docker-compose-v2` on Ubuntu):

```bash
just fluss-homelab-deploy
```

Override the jump alias only when needed with
`OSS_KB_HOMELAB_JUMP_HOST=<ssh-alias>`.

Rerun only the standalone parity check with `just fluss-homelab-validate`.
Inspect with `just fluss-homelab-status` or `just fluss-homelab-logs` and stop
services with `just fluss-homelab-stop`. The stop path preserves volumes and
all timestamped evidence.

Successful validation leaves a timestamped candidate and evidence JSON under
`evidence/`. The evidence must report `standalone-session-cluster`, a reachable
Flink overview, the deployment target, `outcome: passed`, and the accepted
projection digest. The wrapper also copies remote evidence back into this local
directory without deleting earlier runs.
