# Coverage targets

There is no global percent target. Targets per task:

- **Every acceptance criterion** has at least one test that asserts it directly.
- **Every error path** the implementer handled has a test.
- **Every public function** added or modified has at least one test.

Internal helpers don't need tests — if they break, the function tests catch it.

## Don't pad coverage
- Don't write tests for trivial getters/setters.
- Don't write a test "just to bump coverage."
- If something is hard to test, that's a design signal — fix the design, not the test.

## When to add an integration test
- The task crosses a layer boundary that hasn't been tested before.
- The task introduces a new external dependency.
- The task fixes a bug found in production — add a regression test.

## Test budget
Test budget: 1 happy-path + at most 2 error-path tests per AC.
- No tests for trivial getters/setters.
- Prefer extending an existing test file over creating one.
- A test beyond the budget needs a one-line reason (a test comment or the report).
