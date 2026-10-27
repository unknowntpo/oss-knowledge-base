# System

oss-knowledge-base collects Apache Kafka and DataFusion community activity: GitHub, Jira, the Kafka dev@ list and KIP pages. It publishes the data to R2 once a day.

The data publisher is one Cloudflare Worker. Its jobs are publication, digest, embedding, cost-guard, retention, identity-links, kip-pages, identity-backfill and sre-agent. Cron triggers start most jobs. The PipelineState Durable Object holds the publication state. Its alarm starts follow-up runs.

GET /health serves the last run of each job as JSON. Each job run writes one Workers Analytics Engine (WAE) data point.

The cost guard checks the month-to-date cost once a day. Past a limit, it trips its breaker. In enforce mode, a trip stops the digest and the embedding job. An R2 Class A trip also pauses the publication.

A rule (Spec 028) is a deterministic check of /health or WAE data points. Its status is ok, warn, firing or unknown. A firing is a rule with status firing: a limit is exceeded now. A tripped cost guard and a failed release CI run are also firings.
