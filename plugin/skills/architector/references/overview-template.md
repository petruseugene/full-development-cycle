# {System Name} — Architecture Overview

<!--
C4-aligned overview. One file per system, kept at docs/architecture/overview.md.
Replace every {placeholder} and delete these comments before committing.
Diagrams live alongside as docs/architecture/diagrams/{context,container,component}.mmd.
-->

## Context

<!-- One-line: who uses this system and what external systems it talks to. Link to diagrams/context.mmd. -->

{Describe the system's users, the value it provides, and the external systems (auth providers, payment gateways, third-party APIs, data sources) it integrates with. Reference `diagrams/context.mmd` for the C4 Context diagram.}

## Containers

<!-- One-line: the deployable units (web app, API, worker, DB) and how they communicate. Link to diagrams/container.mmd. -->

{List each container — web frontend, API service, background worker, database, cache, queue — with its tech stack and the protocols it uses to talk to its neighbours (HTTPS, gRPC, AMQP, etc). Reference `diagrams/container.mmd`.}

## Components

<!-- One-line: the major modules inside each container worth calling out. Link to diagrams/component.mmd if present. -->

{For each non-trivial container, list the internal components/modules and their responsibilities. Keep to the components that a new developer must know to be productive. Reference `diagrams/component.mmd` if produced.}

## Cross-cutting concerns

<!-- One line per concern. Link out to ADRs where the decision was recorded. -->

- **Auth:** {how users and services authenticate — e.g. OIDC via Auth0, mTLS between services. Link the ADR.}
- **Observability:** {logs, metrics, traces stack — e.g. OpenTelemetry → Grafana Cloud. Link the ADR.}
- **Caching:** {what is cached, where, with what TTL/invalidation strategy. Link the ADR.}
- **Error handling:** {error taxonomy, retry policy, circuit breakers, user-facing messaging. Link the ADR.}

## Open ADRs

<!-- ADRs whose Status is `proposed` — decisions still being weighed. -->

- {ADR-NNNN — short title — link to file}
- {ADR-NNNN — short title — link to file}

## Last reviewed

{YYYY-MM-DD} by {name or role}

<!-- Bump this date whenever the overview is re-read end-to-end and confirmed accurate. -->
