import { displayDate, displayTime } from "./format.js";

export function buildTokenFields(appointment, {
  doctorName = "Dr. Khurrum Mansoor",
  receptionContact = "+92 324 4754566"
} = {}) {
  return [
    ["Patient", appointment?.patientName || "-"],
    ...(appointment?.age ? [["Age", String(appointment.age)]] : []),
    ...(appointment?.gender ? [["Gender", appointment.gender]] : []),
    ["Appointment ID", appointment?.appointmentId || "-"],
    ["Doctor", appointment?.doctorName || doctorName],
    ["Clinic", appointment?.locationNameEn || "-"],
    ["Date", appointment?.date ? displayDate(appointment.date) : "-"],
    ["Time", appointment?.time ? displayTime(appointment.time) : "-"],
    ["Reception", receptionContact]
  ];
}

export function printAppointmentToken(appointment, options = {}, windowRef = window) {
  const popup = windowRef.open("", "appointment-token-print", "popup,width=420,height=720");
  if (!popup) return false;

  const documentRef = popup.document;
  documentRef.title = `Token ${appointment?.tokenNumber || ""}`;
  const style = documentRef.createElement("style");
  style.textContent = `
    @page { size: 80mm auto; margin: 5mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; background: #fff; font-family: Arial, sans-serif; }
    main { width: 70mm; margin: 0 auto; padding: 5mm 2mm; text-align: center; }
    h1 { margin: 0; font-size: 18px; }
    .subtitle { margin: 4px 0 14px; font-size: 11px; }
    .token-label { margin-top: 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; }
    .token-number { margin: 2px 0 14px; font-size: 52px; font-weight: 800; line-height: 1; }
    dl { margin: 0; border-top: 1px dashed #333; text-align: left; }
    .row { display: grid; grid-template-columns: 34% 66%; gap: 4px; padding: 6px 0; border-bottom: 1px dashed #bbb; }
    dt { font-size: 11px; font-weight: 700; }
    dd { margin: 0; font-size: 11px; overflow-wrap: anywhere; }
    footer { margin-top: 14px; font-size: 10px; }
    @media print { main { width: 100%; } }
  `;
  documentRef.head.append(style);

  const token = documentRef.createElement("main");
  const heading = documentRef.createElement("h1");
  heading.textContent = "Nighat Medical Complex";
  const subtitle = documentRef.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "Appointment Token";
  const tokenLabel = documentRef.createElement("div");
  tokenLabel.className = "token-label";
  tokenLabel.textContent = "Token Number";
  const tokenNumber = documentRef.createElement("div");
  tokenNumber.className = "token-number";
  tokenNumber.textContent = String(appointment?.tokenNumber || "-");
  const details = documentRef.createElement("dl");

  for (const [label, value] of buildTokenFields(appointment, options)) {
    const row = documentRef.createElement("div");
    row.className = "row";
    const term = documentRef.createElement("dt");
    term.textContent = label;
    const description = documentRef.createElement("dd");
    description.textContent = String(value);
    row.append(term, description);
    details.append(row);
  }

  const footer = documentRef.createElement("footer");
  footer.textContent = "Please arrive at least 10 minutes before your appointment.";
  token.append(heading, subtitle, tokenLabel, tokenNumber, details, footer);
  documentRef.body.replaceChildren(token);
  popup.onafterprint = () => popup.close();
  popup.focus();
  popup.setTimeout(() => popup.print(), 200);
  return true;
}
