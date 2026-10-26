# Tradeoff Patterns

Architecture archetypes the architector skill quotes during tradeoff lookups. Each block is uniform: a `### <name>` heading, a one-line `**When to choose:**` recommendation, and a one-line `**When to avoid:**` counter-indication. Quote a single block verbatim when answering a tradeoff question.

### Monolith

**When to choose:** Small team (≤5 engineers), single deployable, tight feature coupling, and you want the lowest possible operational overhead while you discover the domain.

**When to avoid:** Multiple teams need independent release cadence, the codebase already exceeds what one engineer can hold in their head, or scaling demands diverge sharply across modules.

### Modular Monolith

**When to choose:** You want monolith-style ops simplicity but expect to extract services later — enforce strict module boundaries, in-process calls, and per-module ownership now to make that future split cheap.

**When to avoid:** The team will not actually enforce module boundaries (they collapse to a ball of mud), or you already have clear, independently-scaling bounded contexts that justify real services today.

### Backend-for-Frontend (BFF)

**When to choose:** Multiple client types (web, iOS, Android, partner) each need a tailored API shape, and a shared general-purpose API is causing over-fetching, version drift, or client-side aggregation logic.

**When to avoid:** You only have one client surface, or the BFF would just proxy a single downstream service without aggregation, transformation, or client-specific concerns.

### Event-Driven

**When to choose:** Workflows are inherently asynchronous, multiple consumers care about the same domain events, or you need temporal decoupling and replay for audit, analytics, or recovery.

**When to avoid:** The domain is request/response by nature, you lack the observability to debug async flows, or end-to-end consistency requirements make eventual consistency unacceptable.

### Serverless

**When to choose:** Spiky or unpredictable load, glue code between managed services, low baseline traffic where pay-per-invocation beats idle capacity, and the team is comfortable with vendor-specific runtimes.

**When to avoid:** Sustained high throughput where per-invocation cost dominates, latency-critical paths that cannot tolerate cold starts, or workloads needing long-lived connections, large memory, or heavy local state.

### Edge-First

**When to choose:** Globally distributed users with strict TTFB targets, read-heavy workloads that cache well at the edge, or compliance rules that require regional data handling close to the user.

**When to avoid:** Strongly consistent writes against a single source of truth dominate the workload, or the application logic depends on libraries / runtimes the edge platform does not support.

### Offline-First

**When to choose:** Clients operate in intermittent connectivity (field, mobile, in-store), users expect uninterrupted local interaction, and the domain tolerates conflict resolution on sync (CRDTs, last-write-wins, manual merge).

**When to avoid:** Data must be strongly consistent and globally visible in real time, the client surface is a thin browser tab on reliable networks, or conflict resolution would expose unacceptable business risk.
