# Mobile security checklist (Expo / React Native)

Apply when `feature.json.platform == "mobile"`, in addition to the OWASP and secret checks. Flag only risks introduced by this diff.

## Secrets and client bundle

- `EXPO_PUBLIC_*` values are inlined in plain text in the compiled bundle. Any secret in an `EXPO_PUBLIC_` variable is a blocker.
- No Supabase `service_role` key (or other admin key) anywhere in app code, `app.json`/`app.config.*`, or `.env` files shipped to the client. Only the anon key belongs in the app.

## Token storage

- Auth/session tokens go in SecureStore (`expo-secure-store`), not MMKV or AsyncStorage (both are unencrypted by default).

## Authorization

- Supabase RLS is the authz layer. Every new table needs RLS enabled plus policies; a client-side check alone is not authorization.

## Purchases (RevenueCat)

- Entitlements are validated server-side, never trusted from the client.
- Webhook handler verifies HMAC from the `X-RevenueCat-Webhook-Signature` header, computed over the raw body bytes (not re-serialized JSON), with a constant-time compare.
- Processing is idempotent by event `id` (RevenueCat retries); respond 200 quickly.

## Observability and privacy

- Sentry (`@sentry/react-native`): `sendDefaultPii: false`, `beforeSend` scrubbing of emails, tokens and user content.
- Use an EU-region DSN (EU org host is `*.de.sentry.io`; unverified, confirm in Sentry org settings).
- GDPR / EU data residency: Supabase project in an EU region, Sentry in the EU, no personal data sent to non-EU processors without a documented basis.
