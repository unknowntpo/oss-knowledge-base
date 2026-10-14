# Feature map

What a verifier can open. See [Verification kit](#verification-kit) and the
[workflow](process/workflow.md).

## Environments

| Environment | Web |
| --- | --- |
| Dev | https://dev.example.test |

### Deployed configuration

What each deployed configuration sets.

| Name | Where | Dev | Prod | What it does |
| --- | --- | --- | --- | --- |
| `MODE` | Worker var | `development` | `production` | Names the environment |
| `FLAG_A`, `FLAG_B` | Worker vars | `on\|off` | unset | Status `ok\|failed`; see [Spec 002](specs/002-beta/spec.md) |

Dev today: **one** publication a day.

- Tokens go only to Dev
  and never elsewhere.
  - nested point with `code`

```sh
curl https://dev.example.test/health | jq '.a | .b'
```

## Schedules

| What | Cadence | Turned on by |
| --- | --- | --- |
| Publisher | `7 22 * * *` | `triggers.crons` |
| Digest | none | <script>alert(1)</script> |

## Acceptance IDs by spec

| Spec | IDs | Surface |
| --- | --- | --- |
| [001](specs/001-alpha/spec.md) | A1–A3 | Domain |
| [002](specs/002-beta/spec.md) | B1–B12 (B4 measure) | `/api/x` |

## Verification kit

| Command | Does |
| --- | --- |
| `bun run verify:ui` | Opens views |
