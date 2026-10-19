# Discovery Questions

Run these 10 questions sequentially during architectural intake. No skipping, no reordering — each question feeds the next, and the orchestrator expects them answered in this order before any archetype proposal is made.

1. **Stack / runtime** — What language, framework, and runtime are you targeting (or already locked into), and is that choice negotiable for this work?
2. **Scale (users / RPS)** — What is the realistic 12-month load: concurrent users, peak requests per second, and any known burst multipliers?
3. **Persistence shape** — What does the data look like (relational, document, key-value, time-series, blob), and what is the rough working-set size?
4. **Integrations** — Which external systems, APIs, or third-party SaaS does this need to call into or receive callbacks from?
5. **Deployment target** — Where does this run (single VPS, managed PaaS, Kubernetes, serverless, edge, on-prem), and is the target fixed?
6. **Team size** — How many engineers will own this in the first 6 months, and what is their split across frontend, backend, and ops?
7. **Latency / throughput SLOs** — What are the user-visible response-time and throughput targets, and which paths are latency-critical vs batch-tolerable?
8. **Auth model** — How do users and services authenticate (sessions, JWT, OAuth/OIDC, mTLS, API keys), and is there an existing identity provider to reuse?
9. **Observability defaults** — What logging, metrics, tracing, and alerting tooling is already in use, and what is the on-call expectation?
10. **Cost / sustainability constraints** — What is the monthly infra budget ceiling, and are there carbon, data-residency, or vendor-lock-in constraints to respect?
