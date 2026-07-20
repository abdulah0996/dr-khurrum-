# Launch Readiness

## Verified and configured

- Dr. Khurrum Mansoor / ڈاکٹر خرم منصور
- MBBS displayed; FCPS retained only as an internal pending-verification item
- Consultant Gynecologist / ماہرِ امراضِ نسواں
- Approved bilingual profile and appointment-assistant limitation
- Nighat Medical Complex, complete Jhang address, physical consultation
- Reception +92 335 7504478
- Monday–Friday 09:00–17:00; weekend closure
- Daily 13:00–14:00 prayer and clinic break
- 15-minute slots and deterministic tokens 1–28
- 30-day booking range, 30-minute same-day cutoff, and two-hour patient cancellation/rescheduling cutoffs
- Age-neutral booking with guardian guidance for patients under 18
- Asia/Karachi timezone

## Launch blockers

- FCPS documentary verification; it must remain hidden until verified
- Approval of both emergency-guidance versions before production use
- Medical registration, experience, languages, and profile image if they are to be published
- Google Maps link, consultation fee, email, website, social links, and public-holiday list if they are to be displayed
- Rotate the MongoDB password shared during setup and retain the URI only in private environment variables
- Allowlist the Hostinger egress IP with a narrow CIDR; the current local IP and guarded `drKhurramDB_test` suite are verified
- The idempotent clinic setup has been rerun and the API reports valid doctor, clinic, and schedule configuration
- MongoDB backup/restore evidence
- Git author identity and verified GitHub repository URL
- Hostinger access, production HTTPS domain, and exact CORS origins
- Meta credentials, production number, webhook subscription, and approved template names/languages
- Healthy production endpoint and complete real WhatsApp scenario results

Do not launch until every applicable blocker is resolved.
