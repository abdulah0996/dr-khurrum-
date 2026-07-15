# MongoDB Setup Guide

The application requires MongoDB Atlas through the existing Mongoose models and never seeds patients or appointments.

## Atlas preparation

1. Create a dedicated Atlas project and database.
2. Create a least-privilege application user; do not use an organization or database administrator account at runtime.
3. Restrict network access to Hostinger egress addresses where possible.
4. Store the connection URI privately as `MONGODB_URI`.
5. Test backup and restore into a non-production database before launch.
6. Add only the current test/deployment egress IP or a narrow CIDR to the Atlas IP access list. Remove temporary access after testing.

The database-user password supplied during local setup was shared in conversation and must be rotated before launch. Update local and Hostinger environment values after rotation; never commit the replacement URI.

Connection shape only:

```text
mongodb+srv://<application-user>:<encoded-password>@<atlas-host>/<database-name>?retryWrites=true&w=majority
```

## Verified clinic upsert

After setting the private URI, run:

```bash
npm run setup:clinic
```

This idempotent command upserts the stable slug `nighat-medical-complex-jhang` with:

- Nighat Medical Complex, Jhang, Pakistan
- Monday–Friday, 09:00–17:00
- Break 13:00–14:00
- 15-minute slots and daily limit 28
- Saturday and Sunday closed by omission from `workingDays`
- Asia/Karachi timezone

It refuses to run without `MONGODB_URI`, refuses an unexpected additional active clinic, does not print credentials, and never creates or deletes patient/appointment records.

Existing collection names and document IDs remain unchanged. Active appointment partial unique indexes protect clinic/date/time, clinic/date/token, and patient/date combinations. Tokens are derived from the selected schedule time, so cancellation releases the time/token without renumbering other appointments.

## Controlled integration test

Set `TEST_MONGODB_URI` to the same cluster but a database whose name ends in `_test` (for example `drKhurramDB_test`), then run:

```bash
npm run test:mongodb
```

The script refuses any non-`_test` database and cleans its scoped QA records in `finally`. A connection/access-list error means the suite did not pass and launch readiness must remain blocked.
