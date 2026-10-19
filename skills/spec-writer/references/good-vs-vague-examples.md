# Good vs vague — examples

## Bad: vague requirement
> R1: The login form should be user-friendly.

## Good: observable requirement
> R1: When the user submits an empty email field, the form shows the message "Email is required" inline below the input within 100ms, without a network round-trip.

## Bad: vague AC
> AC: Login works.

## Good: observable AC
> AC: Submitting valid credentials results in a 200 from `POST /api/login`, a `Set-Cookie: session=...` header, and a redirect to `/dashboard`.

## Bad: missing non-goal
*(none listed)*

## Good: explicit non-goals
> - Not implementing OAuth providers in v1 (email + password only).
> - Not implementing password reset flow (separate spec).
> - Not implementing 2FA (tracked separately).
