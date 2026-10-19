# {ADR Title}

<!--
MADR 4.0.0 template. Replace every {placeholder}, then delete these comments.
File name: ADR-NNNN-<kebab-slug>.md (4-digit zero-padded, monotonic).
-->

- **ID:** ADR-{NNNN}
- **Date:** {YYYY-MM-DD}
- **Deciders:** {names or roles, comma-separated}
- **Supersedes:** {ADR-NNNN or "none"}
- **Superseded by:** {ADR-NNNN or "none"}

## Status

`{proposed | accepted | rejected | deprecated | superseded}`

<!--
Pick exactly one of: proposed | accepted | rejected | deprecated | superseded.
When this ADR is later replaced, flip to `superseded` and fill in the "Superseded by" line above.
-->

## Context and Problem Statement

{Describe the architectural force at play in 2-5 sentences. What is happening, what hurts today, and what decision is required? Frame as a question if useful: "How should we ...?"}

## Decision Drivers

<!-- The constraints, qualities, and forces that shape the decision. 3-7 bullets. -->

- {driver 1, e.g. "must support 10x current RPS without re-architecture"}
- {driver 2, e.g. "team has no Kafka experience"}
- {driver 3, e.g. "deploy target is a single VPC"}

## Considered Options

<!-- List 2-4 options. For each, include Pros and Cons sub-blocks. -->

### Option 1 — {short name}

{One-paragraph description of the option.}

**Pros**

- {pro 1}
- {pro 2}

**Cons**

- {con 1}
- {con 2}

### Option 2 — {short name}

{One-paragraph description of the option.}

**Pros**

- {pro 1}
- {pro 2}

**Cons**

- {con 1}
- {con 2}

### Option 3 — {short name}

{One-paragraph description of the option.}

**Pros**

- {pro 1}
- {pro 2}

**Cons**

- {con 1}
- {con 2}

## Decision Outcome

**Chosen option:** "{Option N — short name}"

**Justification:** {Why this option wins against the Decision Drivers. Reference the drivers explicitly.}

## Consequences

**Positive**

- {what gets easier or better}
- {capability unlocked}

**Negative**

- {what gets harder or constrained}
- {debt or risk introduced}

**Follow-ups**

- {action item, owner, due date — or "none"}
