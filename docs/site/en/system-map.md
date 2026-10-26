# System map

Every component that is live in Dev or in Prod, laid out as the system flow, with its live status from that environment's `/health`, where it runs, and what changed since the Prod release tag. Select a component to see its details and its links to Cloudflare or GitHub.

{{map:system}}

## How to read it {#reading}

- **Live only.** A component is drawn only when it is live in the selected environment. Whether it is live comes from the `gate` of its step in [docs/site/flows/system.json](docs/site/flows/system.json): the rows of the Deployed configuration in [docs/feature-map.md](docs/feature-map.md#deployed-configuration) that turn it on. A cell starting with `unset`, `none`, `off` or `no` is off; `dry-run` and `monitor` are on and shown as a chip.
- **Status.** Each component that names a `/health` component shows its status: ok, warn, stale, failed or unknown; the others show n/a. When `/health` cannot be read, every component is unknown and the header says when it was tried.
- **Runs on.** Components run on Cloudflare unless marked **GitHub Actions** or **manual**. A manual step needs a person and a token; nothing schedules it, which is a risk.
- **Links.** Metrics and logs stay in Cloudflare and GitHub; each component links to its Worker logs, AI Gateway logs or R2 bucket, and to the raw `/health`.

## Where the data comes from {#sources}

The page is generated at build time from `system.json`, the Deployed configuration and git (the newest `v*` tag reachable from the build commit, and the pull requests merged since), and reads `/health` in the browser ([Spec 033](docs/specs/033-system-map/spec.md)). Until the publisher reports per-component status, every status is n/a or unknown.
