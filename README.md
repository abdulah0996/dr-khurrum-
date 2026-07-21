# Dr. Khurrum Mansoor WhatsApp AI Appointment Chatbot

This repository contains the existing bilingual React/Vite, Express, Mongoose, and Meta WhatsApp Cloud API appointment system configured for Dr. Khurrum Mansoor at Nighat Medical Complex.

## Verified configuration

- Doctor: Dr. Khurrum Mansoor / ڈاکٹر خرم منصور
- Public qualification: MBBS (`FCPS` remains withheld pending documentary verification)
- Specialty: Consultant Gynecologist / ماہرِ امراضِ نسواں
- Clinic: Nighat Medical Complex, Jhang
- Address: Gojra Road, near Post Office, Jhang Sadar, Samanabad, Jhang, 33200, Pakistan
- Reception: +92 324 4754566
- Schedule: Monday–Friday, 09:00–17:00; Saturday and Sunday closed
- Break: 13:00–14:00
- Appointments: 15 minutes, 28 time-linked tokens per working day
- Timezone: Asia/Karachi

## Local validation

```bash
npm install
npm test
npm run test:coverage
npm run check:dummy-content
npm run build
```

For the guarded real-browser patient journey, set `TEST_MONGODB_URI` to a database ending in `_test`, ensure Chrome or Chromium is installed, build the frontend, and run:

```bash
npm run test:patient-ui
```

This check exercises a complete English booking and Urdu RTL flow at desktop, 412px, 375px, and 320px widths, then removes its scoped QA records.

## MongoDB clinic setup

After a private `MONGODB_URI` is configured, run:

```bash
npm run setup:clinic
```

The command idempotently upserts only Nighat Medical Complex and its verified schedule. It refuses a missing database URI or an unexpected additional active clinic, and never creates patients or appointments.

## Architecture and important files

- Frontend: `src/`
- Express entry: `server/index.js`
- Booking state machine: `server/services/chatbotService.js`
- Verified doctor, clinic, schedule, and policies: `server/config/clinic.js`
- Appointment persistence and concurrency: `server/services/appointmentService.js`
- Availability and token mapping: `server/services/slotService.js`
- WhatsApp service and consent: `server/services/whatsappService.js`
- Mongoose schemas and indexes: `server/models/index.js`
- Clinic setup: `scripts/setup-clinic.js`

`saveSession()` remains the state transition persistence path and calls `session.markModified("draft")` for the Mongoose `Mixed` draft field.

## Remaining launch blockers

- Documentary verification of FCPS before it may be displayed
- Medical registration, experience, languages, profile image, and emergency-content approval
- Google Maps link, break/holiday operational approval, consultation fee, email, website, and social links where desired
- MongoDB password rotation, least-privilege review, Hostinger IP allowlisting, and backup/restore verification
- Git author identity, GitHub remote, and push
- Hostinger variables/domain and Meta WhatsApp credentials/templates
- Health, webhook, and real WhatsApp production testing

See [launch readiness](docs/launch-readiness.md), [environment](docs/environment.md), [deployment](docs/deployment.md), and [MongoDB setup](MONGODB_SETUP_GUIDE.md).
