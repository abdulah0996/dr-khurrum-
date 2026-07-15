# API Reference

## Public

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Safe readiness status, version, MongoDB readiness, and WhatsApp configured flag. |
| `GET` | `/api/public/info` | Doctor, active locations, and active schedules. |
| `GET` | `/api/public/locations` | Active clinic locations. |
| `GET` | `/api/public/slots/dates?locationId=<id>` | Upcoming available dates for a location. |
| `GET` | `/api/public/slots?locationId=<id>&date=YYYY-MM-DD` | Availability for one date. |
| `POST` | `/api/public/chat/message` | Web chat message processed through the same chatbot flow. |
| `POST` | `/api/public/chat/resume` | Restore the authoritative persisted ChatSession prompt for a validated phone number. |

Interactive web-chat selections use stable action IDs and a retry-stable interaction ID:

```json
{
  "phone": "+923001234567",
  "message": "consent_accept",
  "actionId": "consent_accept",
  "interactionId": "550e8400-e29b-41d4-a716-446655440000",
  "messageType": "poll_selection",
  "language": "en"
}
```

Replies retain the existing `{ "reply": ... }` envelope and include `reply.nextStep` plus `reply.input` so the bottom composer follows the persisted session. Repeating a completed `interactionId` returns its saved reply without advancing the session again.

## WhatsApp

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/whatsapp/webhook` | Meta webhook challenge verification. |
| `POST` | `/api/whatsapp/webhook` | Incoming messages and delivery status callbacks. |
| `GET` | `/api/whatsapp/status` | Staff-only WhatsApp configuration status. |
| `GET` | `/api/whatsapp/logs` | Staff-only message logs. |
| `POST` | `/api/whatsapp/send` | Staff-only manual WhatsApp text send. |

## Staff

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/bootstrap/status` | Whether first Super Admin setup is still available. |
| `POST` | `/api/auth/bootstrap` | Create first Super Admin with `ADMIN_BOOTSTRAP_TOKEN`. |
| `POST` | `/api/auth/login` | Staff login. |
| `GET` | `/api/auth/me` | Current staff user. |
| `GET` | `/api/appointments` | List real appointments. |
| `POST` | `/api/appointments` | Add reception-created appointment. |
| `POST` | `/api/appointments/lookup` | Lookup by appointment ID and phone number. |
| `POST` | `/api/appointments/reschedule` | Reschedule an active appointment. |
| `POST` | `/api/appointments/cancel` | Cancel an active appointment. |
| `POST` | `/api/appointments/:appointmentId/reminder` | Send an operational appointment reminder through the guarded WhatsApp sender. |
| `POST` | `/api/appointments/:appointmentId/status` | Mark visited, no-show, cancelled, booked, or rescheduled. |
| `GET` | `/api/slots/availability` | Staff availability check. |
| `GET` | `/api/slots/blocked` | List active blocked dates or slots. |
| `POST` | `/api/slots/blocked` | Block a date or time range. |
| `DELETE` | `/api/slots/blocked/:blockedSlotId` | Remove a block. |
| `GET` | `/api/settings` | Product, doctor, locations, schedules, and WhatsApp status. |
| `PUT` | `/api/settings/schedules/:locationId` | Update timing rules. |
| `GET` | `/api/users` | Super Admin staff list. |
| `POST` | `/api/users` | Super Admin creates staff user. |
