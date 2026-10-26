# Sizing heuristics

## Right-sized

- Touches 1-3 files
- Has 4-8 steps in the implementer's view
- Has a clear, single acceptance criterion ("POST /api/login returns 200 with valid creds")
- Estimated implementer time: 30-90 minutes (with tests + review loop)

## Too small (combine)

- Touches 1 file with 1 line change → fold into adjacent task
- "Create empty file" → fold into the task that fills it

## Too big (split)

- Touches >5 files → split by responsibility
- Has multiple acceptance criteria → one per task
- Cannot be reviewed in one pass → split

## S-task merge rule

- Merge Size-S tasks that are in the same tier and share a file owner (overlapping `Touches`, or the same single directory) into one task.
- Never merge owner tasks (`owner` tag), and never merge tasks with different stack tags.
- Size is a planning hint. Size `L` is informational only and never changes the model.

## Special cases

- **Schema/migration tasks** — always their own task (they have unique blast radius and rollback considerations).
- **Wiring/glue tasks** — their own task at the end (e.g., "wire frontend form to backend API and render error states").
- **Polish/styling** — separate from the functional task. Function first, then style.
