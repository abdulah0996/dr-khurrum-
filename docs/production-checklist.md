# Production Checklist

## Client approval

- [x] Full professional name, Urdu display name, specialty, and bilingual biography are configured.
- [ ] FCPS is verified from an official document; MBBS is the only qualification currently displayed.
- [x] Reception, clinic identity/address, Monday–Friday 09:00–17:00 schedule, break, capacity, and appointment policies are configured.
- [ ] Production WhatsApp number, Google Maps link, fee, and holiday list are verified where applicable.
- [ ] English and Urdu patient content and emergency guidance are approved.

## Technical

- [ ] MongoDB connects with a least-privilege account and backup/restore is tested.
- [x] `npm run setup:clinic` has created one verified active clinic and schedule.
- [ ] HTTPS, exact CORS origins, long secrets, and Hostinger settings are configured.
- [ ] Meta webhook challenge and signature verification pass.
- [ ] The production WhatsApp number and approved templates are configured.
- [x] `npm test`, `npm run test:coverage`, `npm run test:mongodb`, `npm run test:patient-ui`, `npm run check:dummy-content`, `npm run build`, and `npm audit` pass locally.
- [x] Source and generated `dist/` contain no previous-doctor or unapproved public clinical content.
- [ ] Logs contain no access tokens, full payloads, patient draft data, or medical reasons.

## Real WhatsApp verification

- [ ] English and Urdu menus and language switching work.
- [ ] Consent accept/reject, invalid inputs, booking, lookup, reschedule, cancellation, and restart work.
- [ ] Closed dates, past times, unavailable slots, and duplicate confirmations are safe.
- [ ] Clinic, profile, reception, and emergency responses use approved content.
- [ ] Meta retries do not create duplicate appointments.

Launch remains blocked until every item is complete.
