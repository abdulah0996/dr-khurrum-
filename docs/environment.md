# Environment

Copy `.env.example` to `.env` and add private values.

Critical values:

- `NODE_ENV`
- `PORT`
- `APP_BASE_URL`
- `CLIENT_BASE_URL`
- `API_BASE_URL`
- `MONGODB_URI`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `JWT_ACCESS_EXPIRES_IN`
- `JWT_REFRESH_EXPIRES_IN`
- `COOKIE_SECRET`
- `ADMIN_BOOTSTRAP_TOKEN`
- `CORS_ALLOWED_ORIGINS`
- `LOG_LEVEL`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`
- `TRUST_PROXY`
- `DEFAULT_TIMEZONE`

Verified public configuration:

- `DEFAULT_TIMEZONE` — must be `Asia/Karachi`
- `DOCTOR_RECEPTION_PHONE` — optional override of the verified public number

WhatsApp values:

- `WHATSAPP_REQUIRED` (`false` permits web booking before Meta setup; use `true` to fail startup when Meta configuration is incomplete)
- `WHATSAPP_API_VERSION` (confirm the currently supported version in Meta before deployment)
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_VERIFY_TOKEN`
- `META_APP_SECRET`
- `WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION`
- `WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER`
- `WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION`
- `WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION`

Production rules:

- Use HTTPS URLs for `APP_BASE_URL` and `CLIENT_BASE_URL`.
- Do not commit `.env`.
- Keep Meta tokens on the backend only.
- Use exact allowed origins; do not use wildcard CORS in production.
- Create the first Super Admin through the one-time setup flow.
- Use approved utility template names that match the Meta template body variables.
- Production startup always rejects missing database, authentication, URL, or CORS configuration.
- For a web-only launch, set `WHATSAPP_REQUIRED=false`; missing Meta credentials then produce a warning and WhatsApp sends are skipped.
- After Meta setup is complete, set `WHATSAPP_REQUIRED=true` so production fails closed if a required WhatsApp credential is removed.
- Do not place missing-information markers in patient-visible content.
- The verified production reception number is pinned to `+92 324 4754566`; stale environment or database values using the former number are replaced safely at startup.
- `DEFAULT_TIMEZONE` must remain `Asia/Karachi` unless newer client-approved information is supplied.
