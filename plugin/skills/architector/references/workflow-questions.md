# Workflow Intake Questions

A short, sequential intake for documenting a business or work process as a Mermaid diagram. Use this instead of `discovery-questions.md` when the architector is in **workflow-diagram** mode — the architecture intake (scale, persistence, SLOs, etc.) is not relevant here.

Run all five questions in order. Don't skip. If the user invokes the skill with the workflow already described in the prompt (e.g. "document the deployment pipeline that's defined in `Makefile`"), you may answer the questions yourself by reading the named source — but still walk through them mentally so nothing is missed.

## Questions

1. **Purpose** — In one sentence, what does a successful run of this workflow accomplish? (e.g. "A customer order moves from cart to delivered package", "A pull request goes from open to merged on `main`".)

2. **Trigger** — What kicks the workflow off? Is it a user action, a scheduled job, an inbound webhook, a state change elsewhere? Name the exact event.

3. **Actors** — Who or what participates? List every distinct role: human roles (customer, on-call engineer, dispatcher), systems (API, payment provider, warehouse), and any external services. Mark each as human-actor vs system-participant — `sequenceDiagram` renders them differently.

4. **Steps and decisions** — Walk through the happy path step by step. At each step, note: (a) which actor performs it, (b) what the input/output is, (c) any branch points where the path can diverge (e.g. "if payment declined, notify customer and end"). It is fine if this comes back as a numbered list — the diagram type chosen in §6 will determine how it gets visualised.

5. **Failure modes and loops** — What can go wrong, and what's the recovery? Name retries, timeouts, escalations, dead-ends. Be explicit about loop limits (e.g. "retry payment up to 3 times then escalate to manual review").

## After the intake — pick the diagram type

Match the answers to one Mermaid diagram type per `references/workflow-recipes.md`:

| If the workflow is mostly… | Use |
|---|---|
| Sequential steps with branches and loops | `flowchart TD` (or `LR` for wide horizontal flows) |
| Several actors exchanging messages over time | `sequenceDiagram` |
| One entity moving through a finite set of named states | `stateDiagram-v2` |

If two types could fit (e.g. an order moves through states **and** several actors pass it around), prefer the one that surfaces the most decision-relevant detail. Don't produce two diagrams for the same workflow unless the user asks — pick one.

## Output checklist

Before writing the file, confirm:

- The diagram answers a specific question the reader might ask (not just "what does our process look like?" but "where does an order get stuck?", "who's responsible at step 4?").
- Every actor named in question 3 appears in the diagram.
- Every loop named in question 5 is drawn (not buried in prose).
- The diagram block is ≤ 50 non-blank lines. If not, split into sub-diagrams (under H2 headings in the same file when related, or into sibling files when independent).
