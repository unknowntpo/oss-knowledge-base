# Fluss/Flink compatibility spike

This isolated module has two evidence layers on the Java 17 bytecode baseline:

- a fast classpath smoke proving that Flink 1.20.3 discovers the released
  Fluss 0.9.1-incubating catalog connector;
- a cluster-backed bounded replay that starts run-owned Fluss services, writes
  10 observations to a Log Table, runs two Flink materializations across a
  restart boundary, verifies 5 rows in the Primary Key Table, and exports an
  independent Feed candidate matching the Spec 004 oracle.

Run the classpath smoke test:

```bash
mvn -B verify -f spikes/fluss-flink-compat/pom.xml
```

Run the complete isolated cluster slice (Docker, Bun, Maven, and Java 17 are
required):

```bash
bun spikes/fluss-flink-compat/scripts/run-cluster-slice.ts
```

The runner allocates random host ports, a unique Compose project/database, and
a unique temporary evidence directory. It waits on TCP and Fluss catalog
readiness, then removes only its own containers, network, and volume. Set
`PRESERVE_FLUSS_IT=1` only for local diagnosis.

This slice intentionally uses Fluss's supported batch `LIMIT` log read. An
always-running streaming job belongs in a later slice with a standalone Flink
cluster; the embedded detached MiniCluster is not treated as production
restart evidence.

The next standalone deployment slice is under [`homelab/`](homelab/README.md).
It keeps the bounded semantics but submits the materialization through a real
Flink JobManager/TaskManager session cluster on the disposable homelab VM.
