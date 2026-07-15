# Pre-Launch QA Report

Date: 15 July 2026
Project: Dr. Khurrum Mansoor WhatsApp AI Appointment Chatbot

## Release decision

```text
CONSENT FLOW AND PATIENT BOOKING UI COMPLETE — READY FOR FINAL DEPLOYMENT TESTING
```

The repository and controlled database suites are healthy. This means the codebase is ready for the deployment process; it is not yet publicly live. Meta production credentials, Hostinger configuration, password rotation, and real WhatsApp verification remain required before accepting public appointments.

## Root causes and completed fixes

| Severity | Symptom and root cause | Fix | Verification |
| --- | --- | --- | --- |
| Critical | `FEVER` could interrupt booking because symptom matching was mixed with broad intent/emergency keywords | Added one structured routine/needs-attention/emergency classifier and narrowed interruptions to explicit severe warning signs | Routine and emergency regression lists plus a persisted FEVER booking-flow test pass |
| High | Menus could appear as both numbered text and clickable controls because option text was embedded before interactive delivery | Main messages now contain guidance only; normal delivery uses stable interactive controls; numbered text is generated only after an interactive-send failure | Interactive payload and fallback tests pass |
| High | WhatsApp choices could be routed from visible labels and long time lists were truncated | Centralized stable IDs, button/list parsing, dynamic clinic/date/slot IDs, and six-slot time pagination with Previous/More actions | Parsing, mapping, pagination, stale-input recovery, and Back tests pass |
| High | Schedule edits had no safe affected-appointment preview | Added impact calculations for doctor/clinic activation, weekly schedules, leave, special schedules, and blocked slots; affected records are flagged for staff action, never silently cancelled or deleted | Schedule-impact and RBAC tests pass |
| High | Operational doctor data and schedule-impact controls were incomplete | Added private pending qualifications, languages, services, image URL, multi-break rules, special schedules, ranges, reschedule flags, and Super Admin impact confirmations | Validation, HTTP authorization, service, and persistence-script assertions added |
| High | Public appointment output could expose unnecessary patient fields | Public projection now masks phone data and omits normalized phone, reason, patient database ID, and internal metadata | Public projection tests pass |
| Critical | Consent selection could be represented multiple times and had no retry-safe web interaction contract | Standardized `consent_accept` / `consent_reject`, persisted acceptance/rejection timestamps, returned the name prompt immediately, added interaction-ID idempotency, and exposed persisted `nextStep` / input metadata | Unit, isolated MongoDB, and real-browser double-click/reload checks pass |
| High | The booked appointment object contained its `KHR-...` reference, but confirmation and lookup messages did not display it | Added a prominent Appointment ID plus save/use guidance to English and Urdu confirmations, and included the ID in lookup results | Real-browser booking captures the displayed ID and successfully checks the same appointment with it |
| High | Patient detail questions were rendered as embedded form cards instead of a mobile conversation | Moved name, phone, age, city, and reason entry into the normal dynamic bottom composer; retained bot bubbles, human patient bubbles, quiet Back controls, validation, and autofocus | Guarded real-browser English/Urdu journey passes at desktop, 412px, 375px, and 320px |
| Medium | Web chat lacked polished feedback and could submit twice | Added a compact consent poll, loading/selected/disabled states, one patient bubble, no standalone Selected card, message-end scrolling, a privacy footer, synchronous client locking, and persisted retry deduplication | One-request double-click, selected-state, loading, focus, keyboard, refresh, scroll, and console checks pass |
| Low | The welcome card rendered a stray `0` when no progress step existed | Changed conditional rendering to an explicit positive-step check | Rebuilt and visually reviewed |

Critical session and security behavior remains intact: `saveSession()`, `session.markModified("draft")`, Mixed draft persistence, the consent update-path fix, webhook HMAC validation, duplicate-event protection, partial unique appointment indexes, RBAC, public projections, log redaction, CORS, rate limiting, and sanitized database errors.

## Automated results

| Check | Result |
| --- | --- |
| `npm install` | Passed; dependencies already current |
| `npm test` | 71 passed, 0 failed, 0 skipped |
| `npm run test:coverage` | Passed; 74.03% lines, 69.48% branches, 66.48% functions |
| `npm run build` | Passed; Vite 7.3.6, 1,735 modules, JavaScript 313.95 kB / 96.48 kB gzip; CSS 31.26 kB / 7.11 kB gzip |
| `npm run check:dummy-content` | Passed across 69 files |
| `npm audit --audit-level=high` | Passed; 0 vulnerabilities |
| `npm run test:mongodb` | Passed against guarded `drKhurramDB_test`; all scoped records were cleaned |
| `npm run test:patient-ui` | Passed against guarded `drKhurramDB_test`; real Chrome interaction, complete English booking, visible Appointment ID, successful lookup with that ID, FEVER continuation, Urdu RTL, required viewports, and cleanup passed with 0 console errors |

The MongoDB script refuses any database name not ending in `_test`, asserts the connected database name before mutation, scopes records to a unique QA run, and cleans up in `finally`. The passing run covered setup idempotency, doctor/clinic/schedule/multiple-break persistence, consent and patient-name persistence, interaction idempotency, ChatSession resume/reload, special schedules, immediate schedule refresh, date-range leave, a real same-slot race, rescheduling, cancellation, duplicate cancellation, token release, and cleanup.

## Manual verification actually performed

- Loaded the production-built staff login page in headless Chrome at desktop size.
- Loaded the production-built patient chat in real headless Chrome at desktop, 412px, 375px, and 320px viewports with no horizontal overflow.
- Completed an actual English browser booking in `drKhurramDB_test`: language, menu, consent, conversational name, phone, age, gender, city, FEVER, clinic, date, time/token, confirmation, persistence, and cleanup.
- Verified one consent API request after a double click, stable action and interaction IDs, one patient bubble, both consent choices disabled, a visible loading/selected state, no standalone Selected card, immediate name prompt, normal composer autofocus, empty/unsafe/numeric-name validation, Enter submit, Back with preserved value, server-backed refresh recovery at the phone step, internal-ID hiding, footer/input visibility, and zero console errors.
- Captured the generated `KHR-...` Appointment ID from the final confirmation, selected Check Appointment, submitted that same ID and booking phone, and received the correct `Booked` appointment details including the same ID.
- Entered the Urdu browser flow through the conversational patient-name step and verified RTL, Urdu controls, autofocus, and 375px layout.
- A real Meta-device booking/reschedule/cancel journey remains required before announcing the service as publicly live.

## Main files changed and purpose

- `server/services/emergencyClassificationService.js`: structured symptom classification.
- `server/services/chatbotService.js`: retry-safe consent/name transitions, persisted session resume/input metadata, routine-reason continuation, progress, Back, and time pagination.
- `server/services/interactiveMessageService.js`, `server/services/whatsappService.js`, `server/routes/whatsapp.js`: centralized interactive delivery, parsing, fallback, and duplicate safety.
- `server/services/scheduleImpactService.js`, `server/routes/settings.js`, `server/routes/slots.js`: change previews, staff-action flags, and backend RBAC.
- `server/services/appointmentService.js`, `server/services/slotService.js`, `server/models/index.js`: public projection, atomic lifecycle operations, schedule priority, and operational fields.
- `server/utils/validation.js`: doctor, clinic, schedule, leave, special-date, and blocked-slot validation.
- `src/App.jsx`, `src/styles.css`: conversational patient input, compact consent poll, human labels, duplicate locking, refresh recovery, message-end scrolling, privacy footer, responsive choices, RTL, accessibility, and admin dashboard completion.
- `scripts/mongodb-integration-check.js`, `scripts/patient-ui-check.js`, `scripts/check-dummy-content.js`: guarded persistence, real-browser journey, cleanup, and content/qualification scanning.
- `test/`: FEVER, emergency, patient UI source contracts, interactions, booking lifecycle, schedule impact, authorization, security, and WhatsApp regressions.
- `docs/`: current deployment, environment, API, checklist, and readiness guidance.

## Git readiness

- `.env`, `.env.production`, `node_modules/`, `dist/`, `coverage/`, logs, exports, keys, and backups are ignored.
- The local `.env` is not staged. The MongoDB password shared during setup must nevertheless be rotated before deployment.
- No real credential assignment, patient record, generated build output, focused/skipped test, previous-doctor content, or public FCPS display may be committed.
- FCPS remains a private pending qualification only.
- This repository has no first commit, configured Git author identity, or remote yet.

## External launch blockers

1. Rotate the exposed database-user password and update local and Hostinger secrets. The current local IP is active and `npm run test:mongodb` passes.
2. Verify least-privilege Atlas permissions, allowlist the Hostinger egress IP with a narrow CIDR, and complete backup/restore evidence.
3. Configure Git author identity and verified GitHub remote, review the staged diff, commit, and push.
4. Configure Hostinger runtime variables, HTTPS, exact CORS origins, health monitoring, and rollback.
5. Configure Meta production credentials, approved English/Urdu templates, webhook verification/subscription, and the production number.
6. Obtain FCPS-document approval before public display and approve the bilingual emergency content.
7. Complete one real English and one Urdu WhatsApp booking, lookup, reschedule, and cancellation journey before announcing the system as live.
