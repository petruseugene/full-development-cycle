# What to mock (and what not to)

## Mock these
- External HTTP APIs (use a request mock or fixture file)
- Time (use fake timers / freezegun / time-machine)
- Random (seed it for determinism)
- File system writes for unit tests of pure logic
- Email / SMS / push services (test the call was made with right args)

## Don't mock these
- The DB in integration tests (use a real test DB; reset between tests)
- Your own code (mock the boundary, not internal modules)
- Things you don't own AND can't easily mock — write a contract test against a fake instead

## Mock at the seam
- Mock the smallest interface that lets the test compile. If you're mocking 10 methods of a class, you're testing the wrong thing.
