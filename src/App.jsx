import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  Clock,
  KeyRound,
  Languages,
  ListChecks,
  LockKeyhole,
  LogOut,
  MapPin,
  MessageCircle,
  MoreVertical,
  Paperclip,
  Phone,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound,
  UserPlus,
  Users,
  XCircle
} from "lucide-react";
import { displayDate, displayLongDate, displayTime, statusClass, todayIso } from "./lib/format.js";
import { printAppointmentToken } from "./lib/printToken.js";

const PRODUCT = "Dr. Khurrum Mansoor WhatsApp AI Appointment Chatbot";
const DOCTOR = "Dr. Khurrum Mansoor";
const CONTACT = "+92 324 4754566";

const initialData = {
  settings: null,
  appointments: [],
  todaysAppointments: [],
  appointmentPagination: { page: 1, limit: 10, total: 0, totalPages: 1, hasNext: false, hasPrevious: false },
  blockedSlots: [],
  specialSchedules: [],
  messageLogs: [],
  auditLogs: [],
  users: []
};

const navItems = [
  { id: "today", label: "Today's Appointments", icon: Calendar },
  { id: "appointments", label: "All Appointments", icon: ListChecks },
  { id: "add", label: "Add Appointment", icon: Plus },
  { id: "calendar", label: "Availability Calendar", icon: Calendar },
  { id: "doctor", label: "Doctor Profile", icon: UserPlus, superOnly: true },
  { id: "locations", label: "Clinic & Weekly Schedule", icon: MapPin },
  { id: "blocked", label: "Leave & Blocked Slots", icon: Ban },
  { id: "special", label: "Special Schedules", icon: Clock, superOnly: true },
  { id: "logs", label: "WhatsApp Logs", icon: MessageCircle },
  { id: "audit", label: "Audit Logs", icon: ShieldCheck, superOnly: true },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "users", label: "Staff Users", icon: Users, superOnly: true }
];

function isRtl(language) {
  return language === "ur";
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function isValidPhone(value) {
  const normalized = normalizePhone(value);
  return /^(\+?\d{10,15}|03\d{9})$/.test(normalized);
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJson(response) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.message || payload || "Request failed.");
    error.details = payload?.details;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function EmptyState({ children = "No appointments yet. New WhatsApp bookings will appear here." }) {
  return <div className="empty-state">{children}</div>;
}

function confirmScheduleImpact(impact, action) {
  if (!impact?.count) return true;
  const preview = (impact.affectedAppointments || []).slice(0, 6).map((item) => `${item.patientName} — ${item.date} ${item.time}`).join("\n");
  return window.confirm(
    `${action} will affect ${impact.count} active appointment${impact.count === 1 ? "" : "s"} across ${(impact.affectedDates || []).join(", ")}.\n\n${preview}${impact.count > 6 ? "\n…" : ""}\n\nNo appointment will be deleted or cancelled. Affected appointments will be flagged for staff action. Continue?`
  );
}

function impactFlash(impact, fallback) {
  return impact?.count ? `${fallback} ${impact.count} appointment${impact.count === 1 ? " was" : "s were"} flagged for staff action.` : fallback;
}

function Field({ label, children }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

function Badge({ status }) {
  return <span className={`status-badge ${statusClass(status)}`}>{status || "-"}</span>;
}

export default function App() {
  const isPatientChat = ["/patient-chat", "/whatsapp-chat"].includes(window.location.pathname);
  if (isPatientChat) return <PatientChat />;
  return <AdminApp />;
}

function AdminApp() {
  const [token, setToken] = useState(() => localStorage.getItem("khurrum_chatbot_token") || "");
  const [user, setUser] = useState(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [view, setView] = useState("today");
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [sectionErrors, setSectionErrors] = useState({});
  const refreshRequestRef = useRef(null);

  const refreshAccess = useCallback(async () => {
    if (!refreshRequestRef.current) {
      refreshRequestRef.current = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
        .then(readJson)
        .then((payload) => {
          localStorage.setItem("khurrum_chatbot_token", payload.token);
          setToken(payload.token);
          setUser(payload.user);
          return payload.token;
        })
        .finally(() => { refreshRequestRef.current = null; });
    }
    return refreshRequestRef.current;
  }, []);

  const api = useCallback(
    async (path, options = {}) => {
      const request = (accessToken) => fetch(`/api${path}`, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(accessToken)
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: "include",
        signal: options.signal
      });
      let response = await request(token);
      const refreshExcluded = ["/auth/login", "/auth/bootstrap", "/auth/refresh", "/auth/logout"].includes(path);
      if (response.status === 401 && !refreshExcluded) {
        const accessToken = await refreshAccess();
        response = await request(accessToken);
      }
      return readJson(response);
    },
    [refreshAccess, token]
  );

  const flash = (message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  };

  const loadData = useCallback(async (options = {}) => {
    if (!token) return;
    const skipAppointments = options?.skipAppointments === true;
    if (!skipAppointments) setAppointmentsLoading(true);
    const loadAllToday = async () => {
      const records = [];
      const maxPages = 10;
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await api(`/appointments?date=${encodeURIComponent(todayIso())}&page=${page}&limit=200`);
        records.push(...(result.appointments || []));
        if (!result.pagination?.hasNext) return { records, truncated: false };
      }
      return { records, truncated: true };
    };
    const appointmentBatch = skipAppointments ? [] : [
      api("/appointments?page=1&limit=10"),
      loadAllToday()
    ];
    const appointmentsRequest = Promise.allSettled(appointmentBatch)
      .then((appointmentResults) => {
        if (skipAppointments) return;
        const [allResult, todayResult] = appointmentResults;
        setData((current) => ({
          ...current,
          appointments: allResult.status === "fulfilled" ? allResult.value.appointments || [] : current.appointments,
          todaysAppointments: todayResult.status === "fulfilled" ? todayResult.value.records : current.todaysAppointments,
          appointmentPagination: allResult.status === "fulfilled" ? allResult.value.pagination || current.appointmentPagination : current.appointmentPagination
        }));
        const appointmentError = allResult.status === "rejected" ? "Appointments could not be refreshed." : "";
        const todayError = todayResult.status === "rejected"
          ? "Today's appointments could not be refreshed."
          : todayResult.value.truncated ? "Today's appointment list exceeds the safe display limit. Narrow the clinic schedule and contact support." : "";
        setSectionErrors((current) => ({ ...current, appointments: appointmentError, todaysAppointments: todayError }));
        if (appointmentError || todayError) setNotice("Appointments could not be fully refreshed. Your saved records have not been removed. Please try Refresh again.");
      })
      .finally(() => setAppointmentsLoading(false));

    const results = await Promise.allSettled([
      api("/settings"),
      api("/slots/blocked"),
      api("/slots/special"),
      api("/whatsapp/logs"),
      user?.role === "Super Admin" ? api("/settings/audit-logs") : Promise.resolve({ auditLogs: [] }),
      user?.role === "Super Admin" ? api("/users") : Promise.resolve({ users: [] })
    ]);
    const value = (index, fallback) => (results[index].status === "fulfilled" ? results[index].value : fallback);
    const settings = value(0, {});
    await appointmentsRequest;
    const names = ["settings", "blockedSlots", "specialSchedules", "messageLogs", "auditLogs", "users"];
    const failures = Object.fromEntries(names.map((name, index) => [name, results[index].status === "rejected" ? `${name} could not be refreshed.` : ""]));
    setSectionErrors((current) => ({ ...current, ...failures }));
    setData((current) => ({
      settings: settings.product ? settings : current.settings,
      appointments: current.appointments,
      todaysAppointments: current.todaysAppointments,
      appointmentPagination: current.appointmentPagination,
      blockedSlots: results[1].status === "fulfilled" ? results[1].value.blockedSlots || [] : current.blockedSlots,
      specialSchedules: results[2].status === "fulfilled" ? results[2].value.specialSchedules || [] : current.specialSchedules,
      messageLogs: results[3].status === "fulfilled" ? results[3].value.messageLogs || [] : current.messageLogs,
      auditLogs: results[4].status === "fulfilled" ? results[4].value.auditLogs || [] : current.auditLogs,
      users: results[5].status === "fulfilled" ? results[5].value.users || [] : current.users
    }));
  }, [api, token, user?.role]);

  useEffect(() => {
    async function boot() {
      try {
        const statusResponse = await fetch("/api/auth/bootstrap/status");
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          setSetupRequired(Boolean(status.setupRequired));
        }
        if (token) {
          const me = await api("/auth/me");
          setUser(me.user);
        }
      } catch {
        localStorage.removeItem("khurrum_chatbot_token");
        setToken("");
        setUser(null);
      } finally {
        setLoading(false);
      }
    }
    boot();
  }, [api, token]);

  useEffect(() => {
    if (user) loadData();
  }, [loadData, user]);

  const login = async (body) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include"
    });
    const payload = await readJson(response);
    localStorage.setItem("khurrum_chatbot_token", payload.token);
    setToken(payload.token);
    setUser(payload.user);
    setSetupRequired(false);
    flash(`Signed in as ${payload.user.role}.`);
  };

  const bootstrap = async (body) => {
    const response = await fetch("/api/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include"
    });
    const payload = await readJson(response);
    localStorage.setItem("khurrum_chatbot_token", payload.token);
    setToken(payload.token);
    setUser(payload.user);
    setSetupRequired(false);
    flash("First Super Admin created.");
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.removeItem("khurrum_chatbot_token");
    setToken("");
    setUser(null);
    setData(initialData);
    setAppointmentsLoading(false);
  };

  if (loading) return <LoadingScreen />;
  if (!token || !user) {
    return setupRequired ? <BootstrapScreen onSubmit={bootstrap} /> : <LoginScreen onSubmit={login} />;
  }

  const allowedNav = navItems.filter((item) => !item.superOnly || user.role === "Super Admin");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">
            <MessageCircle size={24} />
          </div>
          <div>
            <strong>{DOCTOR}</strong>
            <span>WhatsApp appointment assistant</span>
          </div>
        </div>
        <nav className="nav-list">
          {allowedNav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <a className="ghost-link" href="/patient-chat">
          <MessageCircle size={16} />
          Patient chat
        </a>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{PRODUCT}</p>
            <h1>{allowedNav.find((item) => item.id === view)?.label || PRODUCT}</h1>
            <p>{DOCTOR}{CONTACT ? ` · ${CONTACT}` : ""}</p>
          </div>
          <div className="topbar-actions">
            {notice && <div className="toast">{notice}</div>}
            <div className="user-pill">
              <span className="avatar small">{user.name?.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{user.name}</strong>
                <small>{user.role}</small>
              </div>
            </div>
            <button className="icon-button" title="Refresh" onClick={loadData}>
              <RefreshCw size={18} />
            </button>
            <button className="icon-button" title="Logout" onClick={logout}>
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <section className="content">
          {Object.values(sectionErrors).some(Boolean) && <div className="form-error" role="alert">{Object.values(sectionErrors).filter(Boolean).join(" ")} Previously loaded records are still shown. <button type="button" className="ghost-button" onClick={loadData}>Retry</button></div>}
          {view === "today" && <TodayView appointments={data.todaysAppointments} loading={appointmentsLoading} />}
          {view === "appointments" && <AppointmentsView appointments={data.appointments} initialPagination={data.appointmentPagination} loading={appointmentsLoading} api={api} refresh={loadData} flash={flash} canDelete={user?.role === "Super Admin"} />}
          {view === "add" && <AddAppointmentView settings={data.settings} api={api} refresh={loadData} flash={flash} />}
          {view === "calendar" && <AvailabilityCalendarView settings={data.settings} api={api} />}
          {view === "doctor" && <DoctorProfileView settings={data.settings} api={api} refresh={loadData} flash={flash} />}
          {view === "locations" && <LocationsView settings={data.settings} api={api} refresh={loadData} flash={flash} canEdit={user.role === "Super Admin"} />}
          {view === "blocked" && <BlockedSlotsView settings={data.settings} blockedSlots={data.blockedSlots} api={api} refresh={loadData} flash={flash} canEdit={user.role === "Super Admin"} />}
          {view === "special" && <SpecialSchedulesView settings={data.settings} specialSchedules={data.specialSchedules} api={api} refresh={loadData} flash={flash} />}
          {view === "logs" && <WhatsAppLogsView settings={data.settings} messageLogs={data.messageLogs} api={api} refresh={loadData} flash={flash} />}
          {view === "audit" && <AuditLogsView auditLogs={data.auditLogs} />}
          {view === "settings" && <SettingsView settings={data.settings} />}
          {view === "users" && <UsersView users={data.users} api={api} refresh={loadData} flash={flash} />}
        </section>
      </main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="loader-panel">
      <RefreshCw className="spin" />
      Loading appointment chatbot...
    </main>
  );
}

function LoginScreen({ onSubmit }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const submit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError("");
    setSubmitting(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.status === 401 || err.status === 429 ? err.message : "We could not sign you in right now. Please try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-hero">
        <div className="brand-mark">
          <MessageCircle size={34} />
        </div>
        <p className="eyebrow">Secure staff access</p>
        <h1>{PRODUCT}</h1>
        <p>Use this panel only for appointments, locations, timings, blocked slots, staff users, and WhatsApp logs.</p>
      </section>
      <form className="auth-card" onSubmit={submit}>
        <div className="login-card-title">
          <LockKeyhole />
          <div>
            <h2>Staff Login</h2>
            <p>No public staff signup is available.</p>
          </div>
        </div>
        <Field label="Email">
          <input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={submitting}>
          <ShieldCheck size={18} />
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </main>
  );
}

function BootstrapScreen({ onSubmit }) {
  const [form, setForm] = useState({ token: "", name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-hero">
        <div className="brand-mark">
          <KeyRound size={34} />
        </div>
        <p className="eyebrow">One-time setup</p>
        <h1>Create the first Super Admin</h1>
        <p>This setup works only before any Super Admin exists and requires the private bootstrap token.</p>
      </section>
      <form className="auth-card" onSubmit={submit}>
        <Field label="Bootstrap Token">
          <input value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} required />
        </Field>
        <Field label="Full Name">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        </Field>
        <Field label="Strong Password">
          <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={submitting}>
          <ShieldCheck size={18} />
          {submitting ? "Creating…" : "Create Super Admin"}
        </button>
      </form>
    </main>
  );
}

function TodayView({ appointments, loading }) {
  const today = todayIso();
  const todaysAppointments = appointments.filter((appointment) => appointment.date === today);
  const active = todaysAppointments.filter((appointment) => ["Booked", "Rescheduled"].includes(appointment.status));
  const visited = todaysAppointments.filter((appointment) => appointment.status === "Visited");
  const cancelled = todaysAppointments.filter((appointment) => appointment.status === "Cancelled");
  const noShows = todaysAppointments.filter((appointment) => appointment.status === "No-Show");

  return (
    <div className="page-stack">
      <div className="stat-grid">
        <Stat icon={Calendar} label="Today's active appointments" value={active.length} />
        <Stat icon={CheckCircle2} label="Visited" value={visited.length} tone="green" />
        <Stat icon={XCircle} label="Cancelled" value={cancelled.length} tone="red" />
        <Stat icon={XCircle} label="No-shows" value={noShows.length} tone="blue" />
      </div>
      <section className="panel wide">
        <div className="panel-heading">
          <div>
            <h2>Today's Appointments</h2>
            <p>Only real bookings saved in MongoDB appear here.</p>
          </div>
        </div>
        <AppointmentTable
          appointments={todaysAppointments}
          loading={loading}
          actions={(appointment) => ["Booked", "Rescheduled"].includes(appointment.status) && (
            <button type="button" title="Print Token" onClick={() => printAppointmentToken(appointment, { doctorName: DOCTOR, receptionContact: CONTACT })}>
              <Printer size={15} /> Print
            </button>
          )}
        />
      </section>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone = "" }) {
  return (
    <article className={`stat-card ${tone}`}>
      <div className="stat-icon">
        <Icon size={21} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AppointmentsView({ appointments, initialPagination, loading, api, refresh, flash, canDelete = false }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [reschedule, setReschedule] = useState(null);
  const [noShowCandidate, setNoShowCandidate] = useState(null);
  const [noShowReason, setNoShowReason] = useState("");
  const [requiresOnly, setRequiresOnly] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [records, setRecords] = useState(appointments);
  const [pagination, setPagination] = useState(initialPagination);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const requestRef = useRef({ sequence: 0, controller: null });
  const skipInitialSearchRef = useRef(true);

  useEffect(() => { setRecords(appointments); }, [appointments]);
  useEffect(() => { setPagination(initialPagination); }, [initialPagination]);

  const loadPage = useCallback(async (page = 1) => {
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = requestRef.current.sequence + 1;
    requestRef.current = { sequence, controller };
    setPageLoading(true);
    setPageError("");
    try {
      const params = new URLSearchParams({ page: String(page), limit: "10" });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      if (requiresOnly) params.set("requiresReschedule", "true");
      const result = await api(`/appointments?${params}`, { signal: controller.signal });
      if (requestRef.current.sequence !== sequence) return;
      setRecords(result.appointments || []);
      setPagination(result.pagination || initialPagination);
      setSelectedIds([]);
    } catch (error) {
      if (error?.name !== "AbortError" && requestRef.current.sequence === sequence) {
        setPageError(error.message || "Appointments could not be loaded. Please retry.");
      }
      throw error;
    } finally {
      if (requestRef.current.sequence === sequence) setPageLoading(false);
    }
  }, [api, initialPagination, q, requiresOnly, status]);

  useEffect(() => {
    if (skipInitialSearchRef.current) {
      skipInitialSearchRef.current = false;
      return undefined;
    }
    const timer = window.setTimeout(() => { loadPage(1).catch(() => {}); }, 300);
    return () => {
      window.clearTimeout(timer);
      requestRef.current.controller?.abort();
    };
  }, [loadPage]);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return records.filter((appointment) => {
      const haystack = [appointment.appointmentId, appointment.patientName, appointment.normalizedPhone, appointment.date, appointment.locationNameEn].join(" ").toLowerCase();
      return (!needle || haystack.includes(needle)) && (!status || appointment.status === status) && (!requiresOnly || appointment.requiresReschedule);
    });
  }, [records, q, requiresOnly, status]);

  const markStatus = async (appointment, nextStatus) => {
    let reason = "";
    if (nextStatus === "No-Show") {
      setNoShowCandidate(appointment);
      setNoShowReason("");
      return;
    }
    setActionLoading(appointment.appointmentId);
    setPageError("");
    try {
      await api(`/appointments/${appointment.appointmentId}/status`, { method: "POST", body: { status: nextStatus, ...(reason ? { reason: reason.trim() } : {}) } });
      await refresh();
      await loadPage(pagination.page);
      flash(`Appointment marked ${nextStatus}.`);
    } catch (error) {
      setPageError(error.message || `Appointment could not be marked ${nextStatus}.`);
    } finally {
      setActionLoading("");
    }
  };

  const confirmNoShow = async (event) => {
    event.preventDefault();
    if (!noShowCandidate || noShowReason.trim().length < 3) return;
    const appointment = noShowCandidate;
    setActionLoading(appointment.appointmentId);
    setPageError("");
    try {
      await api(`/appointments/${appointment.appointmentId}/status`, {
        method: "POST",
        body: { status: "No-Show", reason: noShowReason.trim() }
      });
      setNoShowCandidate(null);
      setNoShowReason("");
      await refresh();
      await loadPage(pagination.page);
      flash("Appointment marked No-Show.");
    } catch (error) {
      setPageError(error.message || "Appointment could not be marked No-Show.");
    } finally {
      setActionLoading("");
    }
  };

  const cancel = async (appointment) => {
    const reason = window.prompt("Cancellation reason");
    if (!reason) return;
    if (!window.confirm(`Cancel ${appointment.appointmentId}? The record will be preserved and the slot released.`)) return;
    setActionLoading(appointment.appointmentId);
    setPageError("");
    try {
      await api("/appointments/cancel", {
        method: "POST",
        body: { appointmentId: appointment.appointmentId, phone: appointment.normalizedPhone, reason }
      });
      await refresh();
      await loadPage(pagination.page);
      flash("Appointment cancelled.");
    } catch (error) {
      setPageError(error.message || "Appointment could not be cancelled.");
    } finally {
      setActionLoading("");
    }
  };

  const retryAlert = async (appointment) => {
    const actionKey = `alert:${appointment.appointmentId}`;
    setActionLoading(actionKey);
    try {
      await api(`/appointments/${appointment.appointmentId}/admin-alert/retry`, { method: "POST" });
      await loadPage(pagination.page);
      flash("Personal WhatsApp alert queued for retry.");
    } finally {
      setActionLoading("");
    }
  };

  const retryEmail = async (appointment) => {
    const actionKey = "email:" + appointment.appointmentId;
    setActionLoading(actionKey);
    try {
      await api("/appointments/" + appointment.appointmentId + "/email-alert/retry", { method: "POST" });
      await loadPage(pagination.page);
      flash("Appointment email queued for delivery.");
    } finally {
      setActionLoading("");
    }
  };

  const toggleSelected = (appointmentId) => {
    setSelectedIds((current) => current.includes(appointmentId)
      ? current.filter((id) => id !== appointmentId)
      : [...current, appointmentId]);
  };

  const toggleAllVisible = () => {
    const visibleIds = filtered.map((appointment) => appointment.appointmentId);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  };

  const deleteSelected = async () => {
    if (!canDelete || !selectedIds.length) return;
    const count = selectedIds.length;
    const confirmed = window.confirm(
      `Permanently delete ${count} selected appointment${count === 1 ? "" : "s"}?\n\nThis cannot be undone. Any active slots will be released. Audit and sent-message logs will be preserved.`
    );
    if (!confirmed) return;
    setActionLoading("bulk-delete");
    setPageError("");
    try {
      const result = await api("/appointments", { method: "DELETE", body: { appointmentIds: selectedIds } });
      setSelectedIds([]);
      const remaining = Math.max(0, (pagination.total || 0) - (result.deletedCount || 0));
      const targetPage = Math.min(pagination.page || 1, Math.max(1, Math.ceil(remaining / (pagination.limit || 10))));
      await refresh();
      await loadPage(targetPage);
      flash(`${result.deletedCount || 0} appointment${result.deletedCount === 1 ? "" : "s"} deleted.`);
    } catch (error) {
      setPageError(error.message || "Selected appointments could not be deleted.");
    } finally {
      setActionLoading("");
    }
  };

  return (
    <div className="page-stack">
      <section className="toolbar-panel">
        <div className="search-field">
          <Search size={17} />
          <input value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search appointment ID, name, phone, date, or location" />
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {["Booked", "Rescheduled", "Visited", "No-Show", "Cancelled"].map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <label className="check-row"><input type="checkbox" checked={requiresOnly} onChange={(event) => setRequiresOnly(event.target.checked)} />Requires staff action</label>
      </section>
      <section className="panel wide">
        <div className="panel-heading">
          <div>
            <h2>Appointments</h2>
            <p>{pagination?.total || 0} matching record(s) · {filtered.length} on this page</p>
          </div>
          {canDelete && (
            <button type="button" className="danger-button" disabled={!selectedIds.length || Boolean(actionLoading)} onClick={deleteSelected}>
              <Trash2 size={16} /> Delete Selected{selectedIds.length ? ` (${selectedIds.length})` : ""}
            </button>
          )}
        </div>
        {pageError && <div className="form-error" role="alert">{pageError} <button type="button" className="ghost-button" onClick={() => loadPage(pagination?.page || 1).catch(() => {})}>Retry</button></div>}
        <AppointmentTable
          appointments={filtered}
          loading={loading || pageLoading}
          selectable={canDelete}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onToggleAll={toggleAllVisible}
          actions={(appointment) => (
            <>
            {["Booked", "Rescheduled"].includes(appointment.status) && <>
              <button type="button" title="Print Token" onClick={() => printAppointmentToken(appointment, { doctorName: DOCTOR, receptionContact: CONTACT })}>
                <Printer size={15} /> Print
              </button>
              <button title="Reschedule" disabled={actionLoading === appointment.appointmentId} onClick={() => setReschedule(appointment)}>
                <RefreshCw size={15} />
              </button>
              <button title="Visited" disabled={actionLoading === appointment.appointmentId} onClick={() => markStatus(appointment, "Visited")}>
                <CheckCircle2 size={15} />
              </button>
              <button title="No-show" disabled={actionLoading === appointment.appointmentId} onClick={() => markStatus(appointment, "No-Show")}>
                <XCircle size={15} />
              </button>
              <button title="Cancel" disabled={actionLoading === appointment.appointmentId} onClick={() => cancel(appointment)}>
                <Ban size={15} />
              </button>
            </>}
            {["failed", "dead_letter"].includes(appointment.adminAlert?.status) && (
              <button type="button" className="ghost-button" disabled={Boolean(actionLoading)} onClick={() => retryAlert(appointment)}>
                {actionLoading === `alert:${appointment.appointmentId}` ? "Retrying…" : "Retry Alert"}
              </button>
            )}
            {appointment.emailAlert?.canRetry && (
              <button type="button" className="ghost-button" disabled={Boolean(actionLoading)} onClick={() => retryEmail(appointment)}>
                {actionLoading === "email:" + appointment.appointmentId ? "Retrying email..." : "Retry Email"}
              </button>
            )}
            </>
          )}
        />
        <div className="toolbar-panel">
          <button type="button" className="ghost-button" disabled={!pagination?.hasPrevious || pageLoading} onClick={() => loadPage(pagination.page - 1).catch(() => {})}>Previous</button>
          <span>Page {pagination?.page || 1} of {pagination?.totalPages || 1} · {pagination?.total || 0} record(s)</span>
          <button type="button" className="ghost-button" disabled={!pagination?.hasNext || pageLoading} onClick={() => loadPage(pagination.page + 1).catch(() => {})}>Next</button>
        </div>
      </section>
      {reschedule && <RescheduleModal appointment={reschedule} api={api} refresh={refresh} flash={flash} onClose={() => setReschedule(null)} />}
      {noShowCandidate && <Modal title="Confirm No-Show" onClose={() => actionLoading ? null : setNoShowCandidate(null)}>
        <form className="form-grid" onSubmit={confirmNoShow}>
          <p className="full">This is a terminal status and cannot be reversed.</p>
          <Field label="Patient"><input value={noShowCandidate.patientName} readOnly /></Field>
          <Field label="Current status"><input value={noShowCandidate.status} readOnly /></Field>
          <Field label="Appointment date"><input value={displayDate(noShowCandidate.date)} readOnly /></Field>
          <Field label="Appointment time"><input value={displayTime(noShowCandidate.time)} readOnly /></Field>
          <Field label="Verification note">
            <textarea value={noShowReason} onChange={(event) => setNoShowReason(event.target.value)} minLength={3} maxLength={250} required autoFocus />
          </Field>
          <div className="full row-actions">
            <button type="button" className="ghost-button" disabled={Boolean(actionLoading)} onClick={() => setNoShowCandidate(null)}>Cancel</button>
            <button type="submit" className="danger-button" disabled={Boolean(actionLoading) || noShowReason.trim().length < 3}>{actionLoading ? "Savingâ€¦" : "Confirm No-Show"}</button>
          </div>
        </form>
      </Modal>}
    </div>
  );
}

function AppointmentTable({ appointments, actions, loading = false, selectable = false, selectedIds = [], onToggle, onToggleAll }) {
  if (loading && !appointments.length) return <div className="empty-state">Loading appointments…</div>;
  if (!appointments.length) return <EmptyState />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {selectable && <th><input type="checkbox" aria-label="Select all appointments on this page" checked={appointments.length > 0 && appointments.every((appointment) => selectedIds.includes(appointment.appointmentId))} onChange={onToggleAll} /></th>}
            <th>Patient</th>
            <th>ID</th>
            <th>Date</th>
            <th>Time</th>
            <th>Location</th>
            <th>Token</th>
            <th>Status</th>
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {appointments.map((appointment) => (
            <tr key={appointment.appointmentId}>
              {selectable && <td><input type="checkbox" aria-label={`Select appointment ${appointment.appointmentId}`} checked={selectedIds.includes(appointment.appointmentId)} onChange={() => onToggle(appointment.appointmentId)} /></td>}
              <td>
                <strong>{appointment.patientName}</strong>
                <small>{appointment.normalizedPhone || appointment.maskedPhone}</small>
              </td>
              <td>{appointment.appointmentId}</td>
              <td>{displayDate(appointment.date)}</td>
              <td>{displayTime(appointment.time)}</td>
              <td>{appointment.locationNameEn}</td>
              <td>#{appointment.tokenNumber}</td>
              <td>
                <Badge status={appointment.status} />
                {appointment.requiresReschedule && <small className="attention-text">Staff action required</small>}
                {appointment.adminAlert?.status && (
                  <small>Personal alert: {appointment.adminAlert.status === "dead_letter" ? "Failed" : appointment.adminAlert.status.charAt(0).toUpperCase() + appointment.adminAlert.status.slice(1)}</small>
                )}
                {appointment.emailAlert?.status && (
                  <small>Email: {appointment.emailAlert.status === "dead_letter" ? "Failed" : appointment.emailAlert.status.replace("_", " ").replace(/^./, (value) => value.toUpperCase())}</small>
                )}
              </td>
              {actions && <td className="row-actions">{actions(appointment)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddAppointmentView({ settings, api, refresh, flash }) {
  const locations = settings?.locations || [];
  const [form, setForm] = useState({
    fullName: "",
    phone: "",
    age: "",
    gender: "Male",
    city: "",
    reasonForVisit: "",
    locationId: "",
    date: todayIso(),
    time: "",
    source: "Reception",
    consentAccepted: false
  });
  const [slots, setSlots] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!form.locationId && locations[0]) setForm((current) => ({ ...current, locationId: locations[0].locationId }));
  }, [form.locationId, locations]);

  useEffect(() => {
    async function loadSlots() {
      if (!form.locationId || !form.date) return;
      try {
        const availability = await api(`/slots/availability?locationId=${encodeURIComponent(form.locationId)}&date=${encodeURIComponent(form.date)}`);
        setSlots(availability.availableSlots || []);
        setForm((current) => ({ ...current, time: availability.availableSlots?.[0]?.time || "" }));
      } catch {
        setSlots([]);
      }
    }
    loadSlots();
  }, [api, form.date, form.locationId]);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api("/appointments", { method: "POST", body: { ...form, age: Number(form.age) } });
      setForm({ ...form, fullName: "", phone: "", age: "", city: "", reasonForVisit: "", consentAccepted: false });
      await refresh();
      flash("Appointment booked. WhatsApp status is shown in message logs.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel wide">
      <div className="panel-heading">
        <div>
          <h2>Manual Appointment</h2>
          <p>Use this when a patient calls reception.</p>
        </div>
      </div>
      <AppointmentForm form={form} setForm={setForm} locations={locations} slots={slots} onSubmit={submit} error={error} submitting={submitting} />
    </section>
  );
}

function AppointmentForm({ form, setForm, locations, slots, onSubmit, error, submitting }) {
  return (
    <form className="form-grid" onSubmit={onSubmit}>
      <Field label="Patient Full Name">
        <input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
      </Field>
      <Field label="Phone Number">
        <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required />
      </Field>
      <Field label="Age">
        <input type="number" min="1" max="120" value={form.age} onChange={(event) => setForm({ ...form, age: event.target.value })} required />
      </Field>
      <Field label="Gender">
        <select value={form.gender} onChange={(event) => setForm({ ...form, gender: event.target.value })}>
          <option>Male</option>
          <option>Female</option>
          <option>Other</option>
        </select>
      </Field>
      <Field label="City">
        <input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} required />
      </Field>
      <Field label="Clinic Location">
        <select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })} required>
          {locations.map((location) => (
            <option key={location.locationId} value={location.locationId}>
              {location.nameEn}, {location.city}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Preferred Date">
        <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
      </Field>
      <Field label="Available Time Slot">
        <select value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} required>
          {slots.map((slot) => (
            <option key={slot.time} value={slot.time}>
              {displayTime(slot.time)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason for Visit">
        <textarea value={form.reasonForVisit} onChange={(event) => setForm({ ...form, reasonForVisit: event.target.value })} rows={4} required />
      </Field>
      <label className="check-row full"><input type="checkbox" checked={Boolean(form.consentAccepted)} onChange={(event) => setForm({ ...form, consentAccepted: event.target.checked })} required />Patient consent was obtained, or reception has documented the patient's verbal consent.</label>
      {error && <p className="form-error full">{error}</p>}
      <button className="primary-button full" disabled={submitting || !form.time}>
        <Save size={17} />
        {submitting ? "Booking…" : "Book Appointment"}
      </button>
    </form>
  );
}

function RescheduleModal({ appointment, api, refresh, flash, onClose }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    appointmentId: appointment.appointmentId,
    phone: appointment.normalizedPhone || "",
    locationId: appointment.locationId,
    date: appointment.date,
    time: appointment.time
  });
  const [slots, setSlots] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api("/settings").then(setSettings).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!form.locationId || !form.date) return;
    api(`/slots/availability?locationId=${encodeURIComponent(form.locationId)}&date=${encodeURIComponent(form.date)}`)
      .then((availability) => setSlots(availability.availableSlots || []))
      .catch(() => setSlots([]));
  }, [api, form.date, form.locationId]);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api("/appointments/reschedule", { method: "POST", body: form });
      await refresh();
      flash("Appointment rescheduled.");
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Reschedule Appointment" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Appointment ID">
          <input value={form.appointmentId} readOnly />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required />
        </Field>
        <Field label="Location">
          <select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
            {(settings?.locations || []).map((location) => (
              <option key={location.locationId} value={location.locationId}>
                {location.nameEn}, {location.city}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        </Field>
        <Field label="Time">
          <select value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })}>
            {slots.map((slot) => (
              <option key={slot.time} value={slot.time}>
                {displayTime(slot.time)}
              </option>
            ))}
          </select>
        </Field>
        {error && <p className="form-error full">{error}</p>}
        <button className="primary-button full" disabled={submitting || !form.time}>{submitting ? "Saving…" : "Save Reschedule"}</button>
      </form>
    </Modal>
  );
}

function AvailabilityCalendarView({ settings, api }) {
  const locations = settings?.locations || [];
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(todayIso());
  const [availability, setAvailability] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!locationId && locations[0]) setLocationId(locations[0].locationId);
  }, [locationId, locations]);

  useEffect(() => {
    if (!locationId || !date) return;
    setLoading(true);
    setError("");
    api(`/slots/availability?locationId=${encodeURIComponent(locationId)}&date=${encodeURIComponent(date)}`)
      .then(setAvailability)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api, date, locationId]);

  return (
    <section className="panel wide">
      <div className="panel-heading">
        <div>
          <h2>Live Availability Calendar</h2>
          <p>The same effective schedule and slot status used by the chatbot.</p>
        </div>
        {availability && <Badge status={availability.closed ? "Closed" : "Open"} />}
      </div>
      <div className="form-grid calendar-filters">
        <Field label="Clinic">
          <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            {locations.map((location) => <option key={location.locationId} value={location.locationId}>{location.nameEn}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
      </div>
      {loading && <p className="muted">Loading live slots…</p>}
      {error && <p className="form-error">{error}</p>}
      {!loading && availability && (
        <>
          <div className="schedule-summary">
            <span>{availability.effectiveSchedule?.day}</span>
            <span>{availability.effectiveSchedule?.specialScheduleId ? "Special schedule" : "Weekly schedule"}</span>
            <span>{availability.doctorActive ? "Doctor active" : "Doctor inactive"}</span>
          </div>
          <div className="slot-calendar-grid">
            {availability.slots.map((slot) => (
              <div key={slot.time} className={`slot-card ${slot.available ? "available" : "unavailable"}`} title={slot.reason || slot.status}>
                <strong>{displayTime(slot.time)}</strong>
                <small>Token {slot.tokenNumber} · {slot.status}</small>
              </div>
            ))}
            {!availability.slots.length && <EmptyState>No slots generated for this date.</EmptyState>}
          </div>
        </>
      )}
    </section>
  );
}

function DoctorProfileView({ settings, api, refresh, flash }) {
  const doctor = settings?.doctor || {};
  const [form, setForm] = useState(() => ({
    nameEn: doctor.nameEn || "",
    nameUr: doctor.nameUr || "",
    qualificationsEn: doctor.qualificationsEn || "",
    qualificationsUr: doctor.qualificationsUr || "",
    specialtyEn: doctor.specialtyEn || "",
    specialtyUr: doctor.specialtyUr || "",
    biographyEn: doctor.biographyEn || "",
    biographyUr: doctor.biographyUr || "",
    receptionPhone: doctor.receptionPhone || doctor.contact || CONTACT,
    pendingQualificationsText: (doctor.pendingQualifications || []).join(", "),
    languagesText: (doctor.languages || []).join(", "),
    servicesText: (doctor.services || []).map((item) => `${item.titleEn}${item.titleUr ? ` | ${item.titleUr}` : ""}`).join("\n"),
    profileImage: doctor.profileImage || "",
    active: doctor.active ?? true
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const { pendingQualificationsText, languagesText, servicesText, ...profile } = form;
      const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
      const services = servicesText.split("\n").map((line, index) => {
        const [titleEn, titleUr = ""] = line.split("|").map((item) => item.trim());
        return titleEn ? { serviceId: `service-${index + 1}`, titleEn, titleUr } : null;
      }).filter(Boolean);
      const body = { ...profile, pendingQualifications: list(pendingQualificationsText), languages: list(languagesText), services };
      const preview = await api("/settings/doctor/impact", { method: "POST", body });
      if (!confirmScheduleImpact(preview.impact, "Changing doctor availability")) return;
      const result = await api("/settings/doctor", {
        method: "PUT",
        body
      });
      await refresh();
      flash(impactFlash(result.impact, "Doctor profile updated across the admin and chatbot."));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel wide">
      <div className="panel-heading"><div><h2>Doctor Profile</h2><p>Only verified qualifications should be published.</p></div><Badge status={form.active ? "Active" : "Inactive"} /></div>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Name (English)"><input value={form.nameEn} onChange={(event) => setForm({ ...form, nameEn: event.target.value })} required /></Field>
        <Field label="Name (Urdu)"><input dir="rtl" value={form.nameUr} onChange={(event) => setForm({ ...form, nameUr: event.target.value })} required /></Field>
        <Field label="Qualifications (English)"><input value={form.qualificationsEn} onChange={(event) => setForm({ ...form, qualificationsEn: event.target.value })} required /></Field>
        <Field label="Qualifications (Urdu)"><input dir="rtl" value={form.qualificationsUr} onChange={(event) => setForm({ ...form, qualificationsUr: event.target.value })} required /></Field>
        <Field label="Specialty (English)"><input value={form.specialtyEn} onChange={(event) => setForm({ ...form, specialtyEn: event.target.value })} required /></Field>
        <Field label="Specialty (Urdu)"><input dir="rtl" value={form.specialtyUr} onChange={(event) => setForm({ ...form, specialtyUr: event.target.value })} required /></Field>
        <Field label="Biography (English)"><textarea rows={5} value={form.biographyEn} onChange={(event) => setForm({ ...form, biographyEn: event.target.value })} required /></Field>
        <Field label="Biography (Urdu)"><textarea dir="rtl" rows={5} value={form.biographyUr} onChange={(event) => setForm({ ...form, biographyUr: event.target.value })} required /></Field>
        <Field label="Reception Phone"><input value={form.receptionPhone} onChange={(event) => setForm({ ...form, receptionPhone: event.target.value })} required /></Field>
        <Field label="Pending Qualifications (private)"><input value={form.pendingQualificationsText} onChange={(event) => setForm({ ...form, pendingQualificationsText: event.target.value })} placeholder="FCPS" /></Field>
        <Field label="Languages (comma separated)"><input value={form.languagesText} onChange={(event) => setForm({ ...form, languagesText: event.target.value })} placeholder="English, Urdu" /></Field>
        <Field label="Services (one per line: English | Urdu)"><textarea rows={5} value={form.servicesText} onChange={(event) => setForm({ ...form, servicesText: event.target.value })} /></Field>
        <Field label="Profile Image URL (optional)"><input type="url" value={form.profileImage} onChange={(event) => setForm({ ...form, profileImage: event.target.value })} /></Field>
        <label className="check-row"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Doctor available for bookings</label>
        {error && <p className="form-error full">{error}</p>}
        <button className="primary-button full" disabled={submitting}>{submitting ? "Saving…" : "Save Doctor Profile"}</button>
      </form>
    </section>
  );
}

function SpecialSchedulesView({ settings, specialSchedules, api, refresh, flash }) {
  const locations = settings?.locations || [];
  const schedules = settings?.schedules || [];
  const scheduleDefaults = (locationId, date) => {
    const schedule = schedules.find((item) => item.locationId === locationId);
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${date}T12:00:00`).getDay()];
    const rule = schedule?.dayRules?.find((item) => item.day === day);
    return {
      working: rule?.working ?? Boolean(schedule?.workingDays?.includes(day)),
      openingTime: rule?.openingTime || schedule?.openingTime || "09:00",
      closingTime: rule?.closingTime || schedule?.closingTime || "14:00",
      slotDurationMinutes: rule?.slotDurationMinutes || schedule?.slotDurationMinutes || 10,
      dailyLimit: rule?.dailyLimit || schedule?.dailyLimit || 30,
      breaks: rule?.breaks || []
    };
  };
  const emptyForm = () => {
    const locationId = locations[0]?.locationId || "";
    const date = todayIso();
    return ({
    locationId,
    date,
    ...scheduleDefaults(locationId, date),
    labelEn: "Special clinic hours",
    labelUr: "خصوصی کلینک اوقات",
    active: true
  });
  };
  const [form, setForm] = useState(emptyForm);
  const [formDirty, setFormDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!formDirty && locations[0]) {
      const locationId = form.locationId || locations[0].locationId;
      setForm((current) => ({ ...current, locationId, ...scheduleDefaults(locationId, current.date) }));
    }
  }, [settings, form.locationId, formDirty]);

  const addBreak = () => setForm({ ...form, breaks: [...form.breaks, { breakId: `break-${Date.now()}`, startTime: "13:00", endTime: "14:00", labelEn: "Break", labelUr: "وقفہ" }] });
  const changeBreak = (index, field, value) => setForm({ ...form, breaks: form.breaks.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) });

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const preview = await api("/slots/special/impact", { method: "POST", body: form });
      if (!confirmScheduleImpact(preview.impact, "Saving this special schedule")) return;
      const result = await api("/slots/special", { method: "PUT", body: form });
      setFormDirty(false);
      await refresh();
      flash(impactFlash(result.impact, "Special schedule saved."));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (item) => {
    const preview = await api(`/slots/special/${item.specialScheduleId}/removal-impact`, { method: "POST" });
    if (!confirmScheduleImpact(preview.impact, `Removing the special schedule for ${item.date}`)) return;
    const result = await api(`/slots/special/${item.specialScheduleId}`, { method: "DELETE" });
    await refresh();
    flash(impactFlash(result.impact, "Special schedule removed."));
  };

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Special Date Override</h2><p>Open a normally closed day or replace normal hours for one date.</p></div></div>
        <form className="form-grid single" onSubmit={submit} onChange={() => setFormDirty(true)}>
          <Field label="Clinic"><select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value, ...scheduleDefaults(event.target.value, form.date) })}>{locations.map((item) => <option key={item.locationId} value={item.locationId}>{item.nameEn}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value, ...scheduleDefaults(form.locationId, event.target.value) })} required /></Field>
          <label className="check-row"><input type="checkbox" checked={form.working} onChange={(event) => setForm({ ...form, working: event.target.checked })} />Clinic open on this date</label>
          {form.working && <><Field label="Opening"><input type="time" value={form.openingTime} onChange={(event) => setForm({ ...form, openingTime: event.target.value })} /></Field><Field label="Closing"><input type="time" value={form.closingTime} onChange={(event) => setForm({ ...form, closingTime: event.target.value })} /></Field><Field label="Slot minutes"><input type="number" min="5" max="120" value={form.slotDurationMinutes} onChange={(event) => setForm({ ...form, slotDurationMinutes: Number(event.target.value) })} /></Field><Field label="Daily limit"><input type="number" min="1" max="200" value={form.dailyLimit} onChange={(event) => setForm({ ...form, dailyLimit: Number(event.target.value) })} /></Field></>}
          {form.breaks.map((item, index) => <div className="break-editor" key={item.breakId}><input type="time" value={item.startTime} onChange={(event) => changeBreak(index, "startTime", event.target.value)} /><input type="time" value={item.endTime} onChange={(event) => changeBreak(index, "endTime", event.target.value)} /><button type="button" className="ghost-button" onClick={() => setForm({ ...form, breaks: form.breaks.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button></div>)}
          {form.working && <button type="button" className="ghost-button" onClick={addBreak}>+ Add break</button>}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={submitting}>{submitting ? "Saving…" : "Save Special Schedule"}</button>
        </form>
      </section>
      <section className="panel"><div className="panel-heading"><h2>Upcoming Overrides</h2></div><div className="block-list">{!specialSchedules.length && <EmptyState>No special schedules.</EmptyState>}{specialSchedules.map((item) => <div className="block-item" key={item.specialScheduleId}><div><strong>{displayDate(item.date)} · {item.working ? "Open" : "Closed"}</strong><small>{item.working ? `${displayTime(item.openingTime)} - ${displayTime(item.closingTime)}` : item.labelEn}</small></div><button type="button" className="ghost-button" onClick={() => remove(item)}>Remove</button></div>)}</div></section>
    </div>
  );
}

function LocationsView({ settings, api, refresh, flash, canEdit }) {
  const locations = settings?.locations || [];
  const schedules = settings?.schedules || [];

  return (
    <div className="page-grid">
      {locations.map((location) => (
        <LocationCard key={location.locationId} location={location} schedule={schedules.find((item) => item.locationId === location.locationId)} api={api} refresh={refresh} flash={flash} canEdit={canEdit} />
      ))}
    </div>
  );
}

function LocationCard({ location, schedule, api, refresh, flash, canEdit }) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const makeLocationForm = () => ({
    nameEn: location.nameEn || "",
    nameUr: location.nameUr || "",
    addressEn: location.addressEn || "",
    addressUr: location.addressUr || "",
    city: location.city || "",
    country: location.country || "",
    phone: location.phone || "",
    googleMapLink: location.googleMapLink || "",
    consultationMode: location.consultationMode || "",
    consultationFee: location.consultationFee ?? null,
    timezone: location.timezone || "Asia/Karachi",
    active: location.active ?? true
  });
  const makeScheduleForm = () => ({
    workingDays: schedule?.workingDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    openingTime: schedule?.openingTime || "09:00",
    closingTime: schedule?.closingTime || "14:00",
    breakStart: schedule?.breakStart || "",
    breakEnd: schedule?.breakEnd || "",
    slotDurationMinutes: schedule?.slotDurationMinutes || 10,
    dailyLimit: schedule?.dailyLimit || 30,
    timezone: schedule?.timezone || "Asia/Karachi",
    dayRules: days.map((day) => {
      const existing = schedule?.dayRules?.find((item) => item.day === day);
      return existing || {
        day,
        working: Boolean(schedule?.workingDays?.includes(day)),
        openingTime: schedule?.openingTime || "09:00",
        closingTime: schedule?.closingTime || "14:00",
        slotDurationMinutes: schedule?.slotDurationMinutes || 10,
        dailyLimit: schedule?.dailyLimit || 30,
        breaks: schedule?.breakStart && schedule?.breakEnd
          ? [{ breakId: `${day.toLowerCase()}-break`, startTime: schedule.breakStart, endTime: schedule.breakEnd, labelEn: schedule.breakReasonEn || "Break", labelUr: schedule.breakReasonUr || "وقفہ" }]
          : []
      };
    }),
    active: schedule?.active ?? true
  });
  const [locationForm, setLocationForm] = useState(makeLocationForm);
  const [form, setForm] = useState(makeScheduleForm);
  const [locationDirty, setLocationDirty] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [submitting, setSubmitting] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!locationDirty) setLocationForm(makeLocationForm());
  }, [location, locationDirty]);

  useEffect(() => {
    if (!scheduleDirty) setForm(makeScheduleForm());
  }, [schedule, scheduleDirty]);

  const changeDay = (day, field, value) => setForm((current) => ({
    ...current,
    dayRules: current.dayRules.map((rule) => rule.day === day ? { ...rule, [field]: value } : rule)
  }));

  const addBreak = (day) => {
    const rule = form.dayRules.find((item) => item.day === day);
    changeDay(day, "breaks", [...rule.breaks, { breakId: `${day.toLowerCase()}-${Date.now()}`, startTime: "13:00", endTime: "14:00", labelEn: "Break", labelUr: "وقفہ" }]);
  };

  const changeBreak = (day, index, field, value) => {
    const rule = form.dayRules.find((item) => item.day === day);
    changeDay(day, "breaks", rule.breaks.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  };

  const submitLocation = async (event) => {
    event.preventDefault();
    setSubmitting("location");
    setError("");
    try {
      const preview = await api(`/settings/locations/${location.locationId}/impact`, { method: "POST", body: locationForm });
      if (!confirmScheduleImpact(preview.impact, "Changing clinic availability")) return;
      const result = await api(`/settings/locations/${location.locationId}`, { method: "PUT", body: locationForm });
      setLocationDirty(false);
      await refresh();
      flash(impactFlash(result.impact, "Clinic information updated."));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting("");
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting("schedule");
    setError("");
    try {
      const workingDays = form.dayRules.filter((rule) => rule.working).map((rule) => rule.day);
      const body = { ...form, workingDays };
      const preview = await api(`/settings/schedules/${location.locationId}/impact`, { method: "POST", body });
      if (!confirmScheduleImpact(preview.impact, "Saving this weekly schedule")) return;
      const result = await api(`/settings/schedules/${location.locationId}`, { method: "PUT", body });
      setScheduleDirty(false);
      await refresh();
      flash(impactFlash(result.impact, "Weekly schedule updated."));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting("");
    }
  };

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{location.nameEn}</h2>
          <p>{location.addressEn}</p>
        </div>
      </div>
      <form className="form-grid" onSubmit={submitLocation} onChange={() => setLocationDirty(true)}>
        <Field label="Clinic Name (English)"><input value={locationForm.nameEn} onChange={(event) => setLocationForm({ ...locationForm, nameEn: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Clinic Name (Urdu)"><input dir="rtl" value={locationForm.nameUr} onChange={(event) => setLocationForm({ ...locationForm, nameUr: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Address (English)"><textarea value={locationForm.addressEn} onChange={(event) => setLocationForm({ ...locationForm, addressEn: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Address (Urdu)"><textarea dir="rtl" value={locationForm.addressUr} onChange={(event) => setLocationForm({ ...locationForm, addressUr: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="City"><input value={locationForm.city} onChange={(event) => setLocationForm({ ...locationForm, city: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Phone"><input value={locationForm.phone} onChange={(event) => setLocationForm({ ...locationForm, phone: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Consultation Mode"><input value={locationForm.consultationMode} onChange={(event) => setLocationForm({ ...locationForm, consultationMode: event.target.value })} disabled={!canEdit} /></Field>
        <Field label="Consultation Fee (optional)"><input type="number" min="0" value={locationForm.consultationFee ?? ""} onChange={(event) => setLocationForm({ ...locationForm, consultationFee: event.target.value === "" ? null : Number(event.target.value) })} disabled={!canEdit} /></Field>
        <label className="check-row"><input type="checkbox" checked={locationForm.active} onChange={(event) => setLocationForm({ ...locationForm, active: event.target.checked })} disabled={!canEdit} />Clinic active for bookings</label>
        {canEdit && <button className="primary-button" disabled={Boolean(submitting)}>{submitting === "location" ? "Saving…" : "Save Clinic Information"}</button>}
      </form>
      <hr className="panel-divider" />
      <form className="weekly-schedule" onSubmit={submit} onChange={() => setScheduleDirty(true)}>
        <h3>Weekly Schedule</h3>
        {form.dayRules.map((rule) => (
          <div className={`weekday-editor ${rule.working ? "working" : "closed"}`} key={rule.day}>
            <div className="weekday-header"><label className="check-row"><input type="checkbox" checked={rule.working} onChange={(event) => changeDay(rule.day, "working", event.target.checked)} disabled={!canEdit} />{rule.day}</label><Badge status={rule.working ? "Open" : "Closed"} /></div>
            {rule.working && <div className="weekday-fields">
              <Field label="Opens"><input type="time" value={rule.openingTime} onChange={(event) => changeDay(rule.day, "openingTime", event.target.value)} disabled={!canEdit} /></Field>
              <Field label="Closes"><input type="time" value={rule.closingTime} onChange={(event) => changeDay(rule.day, "closingTime", event.target.value)} disabled={!canEdit} /></Field>
              <Field label="Slot minutes"><input type="number" min="5" max="120" value={rule.slotDurationMinutes} onChange={(event) => changeDay(rule.day, "slotDurationMinutes", Number(event.target.value))} disabled={!canEdit} /></Field>
              <Field label="Daily limit"><input type="number" min="1" max="200" value={rule.dailyLimit} onChange={(event) => changeDay(rule.day, "dailyLimit", Number(event.target.value))} disabled={!canEdit} /></Field>
              <div className="break-list"><strong>Breaks</strong>{rule.breaks.map((item, index) => <div className="break-editor" key={item.breakId}><input type="time" value={item.startTime} onChange={(event) => changeBreak(rule.day, index, "startTime", event.target.value)} disabled={!canEdit} /><input type="time" value={item.endTime} onChange={(event) => changeBreak(rule.day, index, "endTime", event.target.value)} disabled={!canEdit} />{canEdit && <button type="button" className="ghost-button" onClick={() => changeDay(rule.day, "breaks", rule.breaks.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}</div>)}{canEdit && <button type="button" className="ghost-button" onClick={() => addBreak(rule.day)}>+ Add break</button>}</div>
            </div>}
          </div>
        ))}
        {error && <p className="form-error">{error}</p>}
        {canEdit ? (
          <button className="primary-button" disabled={Boolean(submitting)}>
            <Save size={17} />
            {submitting === "schedule" ? "Saving…" : "Save Weekly Schedule"}
          </button>
        ) : (
          <p className="muted">Only a Super Admin can change verified clinic timing.</p>
        )}
      </form>
    </section>
  );
}

function BlockedSlotsView({ settings, blockedSlots, api, refresh, flash, canEdit }) {
  const locations = settings?.locations || [];
  const [form, setForm] = useState({ locationId: "", date: todayIso(), dateEnd: "", startTime: "", endTime: "", fullDay: true, reason: "", reasonUr: "", leaveType: "Leave", requiresReschedule: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!form.locationId && locations[0]) setForm((current) => ({ ...current, locationId: locations[0].locationId }));
  }, [form.locationId, locations]);

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const preview = await api("/slots/blocked/impact", { method: "POST", body: form });
      if (!confirmScheduleImpact(preview.impact, "Saving this leave or block")) return;
      const result = await api("/slots/blocked", { method: "POST", body: { ...form, requiresReschedule: preview.impact.count > 0 || form.requiresReschedule } });
      setForm({ ...form, reason: "", reasonUr: "" });
      await refresh();
      flash(impactFlash(result.impact, "Leave or blocked slot saved."));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (blockedSlot) => {
    if (!window.confirm("Remove this block and reopen any otherwise available slots?")) return;
    await api(`/slots/blocked/${blockedSlot.blockedSlotId}`, { method: "DELETE" });
    await refresh();
    flash("Block removed.");
  };

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Block Date or Slot</h2>
            <p>Bookings are denied for blocked dates and time ranges.</p>
          </div>
        </div>
        {canEdit ? <form className="form-grid single" onSubmit={submit}>
          <Field label="Location">
            <select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
              {locations.map((location) => (
                <option key={location.locationId} value={location.locationId}>
                  {location.nameEn}, {location.city}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
          </Field>
          <Field label="End Date (optional)">
            <input type="date" min={form.date} value={form.dateEnd} onChange={(event) => setForm({ ...form, dateEnd: event.target.value })} />
          </Field>
          <Field label="Type">
            <select value={form.leaveType} onChange={(event) => setForm({ ...form, leaveType: event.target.value })}><option>Leave</option><option>Holiday</option><option>Emergency</option><option>Maintenance</option><option>Other</option></select>
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={form.fullDay} onChange={(event) => setForm({ ...form, fullDay: event.target.checked })} />
            Full day
          </label>
          {!form.fullDay && (
            <>
              <Field label="Start Time">
                <input type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} />
              </Field>
              <Field label="End Time">
                <input type="time" value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} />
              </Field>
            </>
          )}
          <Field label="Reason">
            <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} required />
          </Field>
          <Field label="Reason (Urdu, optional)">
            <input dir="rtl" value={form.reasonUr} onChange={(event) => setForm({ ...form, reasonUr: event.target.value })} />
          </Field>
          <label className="check-row"><input type="checkbox" checked={form.requiresReschedule} onChange={(event) => setForm({ ...form, requiresReschedule: event.target.checked })} />Flag affected appointments for rescheduling</label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={submitting}>
            <Ban size={17} />
            {submitting ? "Saving…" : "Save Block"}
          </button>
        </form> : <p className="muted">Receptionists can view blocks. Only a Super Admin can add, edit, or remove them.</p>}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Active Blocks</h2>
        </div>
        <div className="block-list">
          {!blockedSlots.length && <EmptyState>No blocked dates or slots.</EmptyState>}
          {blockedSlots.map((blockedSlot) => (
            <div className="block-item" key={blockedSlot.blockedSlotId}>
              <div>
                <strong>{displayDate(blockedSlot.date)}{blockedSlot.dateEnd ? ` – ${displayDate(blockedSlot.dateEnd)}` : ""}</strong>
                <small>{blockedSlot.leaveType || "Block"} · {blockedSlot.fullDay ? "Full day" : `${displayTime(blockedSlot.startTime)} - ${displayTime(blockedSlot.endTime)}`} · {blockedSlot.reason}</small>
              </div>
              {canEdit && <button className="ghost-button" onClick={() => remove(blockedSlot)}>Remove</button>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function WhatsAppLogsView({ settings, messageLogs, api, refresh, flash }) {
  const whatsapp = settings?.whatsapp;
  const [manual, setManual] = useState({ phone: "", message: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await api("/whatsapp/send", { method: "POST", body: manual });
      setManual({ phone: "", message: "" });
      await refresh();
      flash(result.whatsapp?.sent ? "WhatsApp message sent." : result.whatsapp?.message || result.whatsapp?.error || "WhatsApp message was not sent.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>WhatsApp API Status</h2>
            <p>{whatsapp?.configured ? "Connected to WhatsApp Cloud API credentials." : "WhatsApp is not configured yet."}</p>
            {whatsapp?.quality?.warning && <p className="form-error">{whatsapp.quality.warning}</p>}
          </div>
          <Badge status={whatsapp?.configured ? "Configured" : "Not Configured"} />
        </div>
        <form className="form-grid single" onSubmit={submit}>
          <Field label="Phone">
            <input value={manual.phone} onChange={(event) => setManual({ ...manual, phone: event.target.value })} required />
          </Field>
          <Field label="Message">
            <textarea value={manual.message} onChange={(event) => setManual({ ...manual, message: event.target.value })} rows={4} required />
          </Field>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={submitting || !whatsapp?.configured}>
            <Send size={17} />
            {submitting ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
      <section className="panel wide">
        <div className="panel-heading">
          <div>
            <h2>Message Logs</h2>
            <p>Provider IDs, delivery statuses, and failures are stored here.</p>
          </div>
        </div>
        {!messageLogs.length ? (
          <EmptyState>No WhatsApp messages logged yet.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Phone</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {messageLogs.map((log) => (
                  <tr key={log.messageLogId}>
                    <td>{log.direction}</td>
                    <td>{log.normalizedPhone}</td>
                    <td>{log.messageType}</td>
                    <td>{log.status}</td>
                    <td className="reason-cell">{log.error || log.messageBody}</td>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AuditLogsView({ auditLogs }) {
  return (
    <section className="panel wide">
      <div className="panel-heading"><div><h2>Security & Change Audit</h2><p>Recent staff and system actions recorded in MongoDB.</p></div></div>
      {!auditLogs.length ? <EmptyState>No audit events found.</EmptyState> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Module</th><th>Action</th><th>Target</th></tr></thead><tbody>{auditLogs.map((item) => <tr key={item.auditLogId}><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.actorUserId}</td><td>{item.actorRole}</td><td>{item.module}</td><td>{item.action}</td><td>{item.targetId || "-"}</td></tr>)}</tbody></table></div>}
    </section>
  );
}

function SettingsView({ settings }) {
  const whatsapp = settings?.whatsapp;
  const doctor = settings?.doctor || {};
  return (
    <div className="page-grid">
      <section className="panel">
        <h2>Doctor Details</h2>
        <DetailGrid
          items={[
            ["Doctor", doctor.nameEn || DOCTOR],
            ["Qualifications", doctor.qualificationsEn || "Not configured"],
            ["Specialty", doctor.specialtyEn || "Not configured"],
            ["Contact", doctor.receptionPhone || doctor.contact || "Not configured"],
            ["Booking Status", doctor.active === false ? "Inactive" : "Active"]
          ]}
        />
      </section>
      <section className="panel">
        <h2>WhatsApp Cloud API</h2>
        <DetailGrid
          items={[
            ["Status", whatsapp?.configured ? "Configured" : "WhatsApp is not configured yet"],
            ["Phone Number ID", whatsapp?.phoneNumberId || "-"],
            ["Business Account ID", whatsapp?.businessAccountId || "-"],
            ["Template: Appointment", whatsapp?.templates?.appointmentConfirmation ? "Configured" : "Missing"],
            ["Template: Reminder", whatsapp?.templates?.appointmentReminder ? "Configured" : "Missing"]
          ]}
        />
      </section>
    </div>
  );
}

function UsersView({ users, api, refresh, flash }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "Receptionist", status: "Active" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api("/users", { method: "POST", body: form });
      setForm({ name: "", email: "", password: "", role: "Receptionist", status: "Active" });
      await refresh();
      flash("Staff user created.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Create Staff User</h2>
            <p>Only Super Admins can manage staff users.</p>
          </div>
        </div>
        <form className="form-grid single" onSubmit={submit}>
          <Field label="Name">
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
          </Field>
          <Field label="Password">
            <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              <option>Receptionist</option>
              <option>Super Admin</option>
            </select>
          </Field>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={submitting}>
            <UserPlus size={17} />
            {submitting ? "Creating…" : "Create User"}
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Staff Users</h2>
        {!users.length ? (
          <EmptyState>No staff users found.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="compact-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.userId}>
                    <td>{item.name}</td>
                    <td>{item.email}</td>
                    <td>{item.role}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const CHAT_NAVIGATION_ACTIONS = new Set(["navigation_back", "main_menu"]);

const CHAT_ACTION_LABELS = {
  en: {
    language_english: "English",
    language_urdu: "اردو",
    consent_accept: "I Agree",
    consent_reject: "I Do Not Agree",
    consent_decline: "I Do Not Agree",
    gender_male: "Male",
    gender_female: "Female",
    gender_other: "Other",
    booking_confirm: "Confirm Appointment",
    booking_cancel: "Cancel Booking",
    reschedule_confirm: "Confirm New Appointment",
    reschedule_cancel: "Keep Current Appointment",
    cancellation_confirm: "Yes, Cancel Appointment",
    cancellation_keep: "No, Keep Appointment",
    navigation_back: "Back",
    main_menu: "Main Menu",
    slots_previous: "Previous Times",
    slots_more: "More Times"
  },
  ur: {
    language_english: "English",
    language_urdu: "اردو",
    consent_accept: "میں متفق ہوں",
    consent_reject: "میں متفق نہیں ہوں",
    consent_decline: "میں متفق نہیں ہوں",
    gender_male: "مرد",
    gender_female: "خاتون",
    gender_other: "دیگر",
    booking_confirm: "اپائنٹمنٹ کی تصدیق کریں",
    booking_cancel: "بکنگ منسوخ کریں",
    reschedule_confirm: "نئی اپائنٹمنٹ کی تصدیق کریں",
    reschedule_cancel: "موجودہ اپائنٹمنٹ برقرار رکھیں",
    cancellation_confirm: "جی ہاں، اپائنٹمنٹ منسوخ کریں",
    cancellation_keep: "نہیں، اپائنٹمنٹ برقرار رکھیں",
    navigation_back: "واپس",
    main_menu: "مین مینو",
    slots_previous: "پچھلے اوقات",
    slots_more: "مزید اوقات"
  }
};

function bookingStep(text = "") {
  const match = String(text).match(/Step\s+(\d)\s+of\s+6|مرحلہ\s+(\d)\s+از\s+6/i);
  return Number(match?.[1] || match?.[2] || 0);
}

function bookingStepName(step, language = "en") {
  const names = language === "ur"
    ? ["رضامندی", "مریض کی تفصیلات", "کلینک", "تاریخ", "وقت", "تصدیق"]
    : ["Consent", "Patient Details", "Clinic", "Date", "Time", "Confirmation"];
  return names[step - 1] || "";
}

function cleanChatText(text = "") {
  return String(text)
    .replace(/^Step\s+\d\s+of\s+6[^\n]*\n?/i, "")
    .replace(/^مرحلہ\s+\d\s+از\s+6[^\n]*\n?/i, "")
    .replace(/\n*Type MENU at any time for the main menu\.?/i, "")
    .replace(/\n*مین مینو کے لیے MENU لکھیں۔?/i, "")
    .trim();
}

function humanOptionLabel(item, language = "en") {
  return CHAT_ACTION_LABELS[language]?.[item.value] || item.label;
}

function taskForChatMessage(message, language = "en") {
  if (!message || message.from !== "bot") return null;
  const fixedChoices = (message.options || []).filter((item) => !CHAT_NAVIGATION_ACTIONS.has(item.value));
  return fixedChoices.length ? null : patientTask(message.text, language);
}

function containsUnsafeMarkup(value = "") {
  return /<\s*\/?\s*script|javascript\s*:|on\w+\s*=|<[^>]+>/i.test(value);
}

function patientTask(text = "", language = "en") {
  const source = cleanChatText(text);
  const urdu = language === "ur";
  const task = (config) => ({ step: bookingStep(text), ...config });

  if (/cancellation reason|منسوخی.*وجہ/i.test(source)) {
    return task({
      key: "cancellationReason",
      icon: XCircle,
      title: urdu ? "منسوخی کی وجہ" : "Cancellation Reason",
      question: urdu ? "آپ اپائنٹمنٹ کیوں منسوخ کرنا چاہتے ہیں؟" : "Why would you like to cancel this appointment?",
      instruction: urdu ? "مختصر وجہ لکھیں۔" : "Please provide a short reason.",
      placeholder: urdu ? "منسوخی کی وجہ لکھیں" : "Enter cancellation reason",
      example: urdu ? "مثال: شیڈول میں تبدیلی" : "Example: Schedule changed",
      multiline: true,
      validate: (value) => value.trim().length >= 2 ? "" : urdu ? "براہِ کرم مختصر وجہ لکھیں۔" : "Please enter a short reason."
    });
  }
  if (/patient(?:’s|\u2019s)? (?:full|complete) name|valid patient name|مریض کا مکمل نام|درست مریض.*نام/i.test(source)) {
    return task({
      key: "fullName",
      icon: UserRound,
      title: urdu ? "مریض کی تفصیلات" : "Patient Details",
      question: urdu ? "مریض کا مکمل نام کیا ہے؟" : "What is the patient’s full name?",
      instruction: urdu ? "نام اسی طرح لکھیں جیسے اپائنٹمنٹ پر ظاہر ہونا چاہیے۔" : "Enter the name exactly as it should appear on the appointment.",
      placeholder: urdu ? "مریض کا مکمل نام لکھیں…" : "Enter patient’s full name…",
      example: urdu ? "مثال: علی احمد" : "Example: Ahmed Khan",
      autoComplete: "name",
      validate: (value) => {
        const normalized = value.trim().replace(/\s+/g, " ");
        const letters = normalized.match(/\p{L}/gu)?.length || 0;
        if (!normalized) return urdu ? "مریض کا نام درکار ہے۔" : "Patient name is required.";
        if (containsUnsafeMarkup(normalized) || normalized.length > 100 || letters < 2 || !/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u.test(normalized)) {
          return urdu ? "براہِ کرم درست مکمل نام لکھیں۔" : "Please enter a valid full name.";
        }
        return "";
      }
    });
  }
  if (/please enter (?:the )?(?:patient(?:’s|'s) )?phone number|please enter a valid phone number|فون نمبر لکھیں|درست فون نمبر لکھیں/i.test(source)) {
    return task({
      key: "bookingPhone",
      icon: Phone,
      title: urdu ? "رابطے کی معلومات" : "Contact Information",
      question: urdu ? "اس اپائنٹمنٹ کے لیے کون سا فون نمبر استعمال کریں؟" : "What phone number should we use for this appointment?",
      instruction: urdu ? "ملک یا موبائل کوڈ کے ساتھ نمبر لکھیں۔" : "Include the country or mobile code.",
      placeholder: urdu ? "فون نمبر لکھیں" : "Enter phone number",
      example: urdu ? "مثال: +92 300 1234567" : "Example: +92 300 1234567",
      inputMode: "tel",
      autoComplete: "tel",
      validate: (value) => isValidPhone(value) ? "" : urdu ? "براہِ کرم درست فون نمبر لکھیں۔" : "Please enter a valid phone number."
    });
  }
  if (/patient age|مریض کی عمر|عمر لکھیں/i.test(source)) {
    return task({
      key: "age",
      icon: UserRound,
      title: urdu ? "مریض کی عمر" : "Patient Age",
      question: urdu ? "مریض کی عمر کیا ہے؟" : "What is the patient’s age?",
      instruction: urdu ? "سالوں میں عمر لکھیں۔" : "Enter age in completed years.",
      placeholder: urdu ? "عمر لکھیں" : "Enter patient age",
      example: urdu ? "مثال: 30" : "Example: 30",
      inputMode: "numeric",
      validate: (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 120
        ? ""
        : urdu ? "براہِ کرم 1 سے 120 کے درمیان عمر لکھیں۔" : "Please enter an age between 1 and 120."
    });
  }
  if (/enter city|شہر کا نام|شہر لکھیں/i.test(source)) {
    return task({
      key: "city",
      icon: MapPin,
      title: urdu ? "شہر" : "City",
      question: urdu ? "مریض کس شہر میں رہتا ہے؟" : "Which city does the patient live in?",
      instruction: urdu ? "اپنے موجودہ شہر کا نام لکھیں۔" : "Enter the patient’s current city.",
      placeholder: urdu ? "شہر کا نام لکھیں" : "Enter city",
      example: urdu ? "مثال: جھنگ" : "Example: Jhang",
      autoComplete: "address-level2",
      validate: (value) => !containsUnsafeMarkup(value) && (value.match(/\p{L}/gu)?.length || 0) >= 2
        ? ""
        : urdu ? "براہِ کرم درست شہر لکھیں۔" : "Please enter a valid city."
    });
  }
  if (/reason for visit|briefly describe|short reason for visit|وزٹ کی.*وجہ.*لکھیں/i.test(source)) {
    return task({
      key: "reasonForVisit",
      icon: MessageCircle,
      title: urdu ? "مشاورت کی وجہ" : "Reason for Visit",
      question: urdu ? "آپ ڈاکٹر سے کس بارے میں مشورہ کرنا چاہتے ہیں؟" : "What would you like to consult the doctor about?",
      instruction: urdu ? "اپنی پریشانی مختصر بیان کریں۔" : "Briefly describe the concern. No diagnosis is made here.",
      placeholder: urdu ? "اپنی پریشانی بیان کریں" : "Describe the concern",
      example: urdu ? "مثال: بخار، معمول کا چیک اپ، کمر درد" : "Example: Fever, routine check-up, back pain",
      multiline: true,
      validate: (value) => !containsUnsafeMarkup(value) && value.trim().length >= 3
        ? ""
        : urdu ? "براہِ کرم مختصر وجہ لکھیں۔" : "Please describe the concern briefly."
    });
  }
  if (/please enter your appointment ID|اپائنٹمنٹ آئی ڈی لکھیں/i.test(source)) {
    return task({
      key: "appointmentId",
      icon: Search,
      title: urdu ? "اپائنٹمنٹ تلاش کریں" : "Find Appointment",
      question: urdu ? "آپ کی اپائنٹمنٹ آئی ڈی کیا ہے؟" : "What is your appointment reference?",
      instruction: urdu ? "تصدیقی پیغام میں موجود آئی ڈی لکھیں۔" : "Enter the reference from your confirmation message.",
      placeholder: urdu ? "اپائنٹمنٹ آئی ڈی لکھیں" : "Enter appointment reference",
      example: urdu ? "مثال: KHR-20260720-ABC123" : "Example: KHR-20260720-ABC123",
      autoComplete: "off",
      validate: (value) => !containsUnsafeMarkup(value) && value.trim().length >= 5
        ? ""
        : urdu ? "براہِ کرم درست اپائنٹمنٹ آئی ڈی لکھیں۔" : "Please enter a valid appointment reference."
    });
  }
  return null;
}

function optionLayout(options = []) {
  const values = options.map((item) => item.value);
  if (values.every((value) => value.startsWith("date_"))) return "date-options";
  if (values.some((value) => value.startsWith("slot_"))) return "time-options";
  if (values.every((value) => value.startsWith("gender_"))) return "short-options";
  if (values.every((value) => value.startsWith("language_"))) return "short-options";
  return "";
}

function isPrimaryChatAction(action = "") {
  return ["consent_accept", "booking_confirm", "reschedule_confirm", "cancellation_confirm"].includes(action);
}

function PatientChat() {
  const phoneRef = useRef(null);
  const composeInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const sendingRef = useRef(false);
  const interactionIdsRef = useRef(new Map());
  const resumeAttemptedRef = useRef(false);
  const [language, setLanguage] = useState(() => localStorage.getItem("khurrum_chat_language") || "en");
  const [phone, setPhone] = useState(() => localStorage.getItem("khurrum_chat_phone") || "");
  const [phoneError, setPhoneError] = useState("");
  const [input, setInput] = useState("");
  const [taskError, setTaskError] = useState("");
  const [actionError, setActionError] = useState("");
  const [typing, setTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [completedMessages, setCompletedMessages] = useState({});
  const [selectedMessages, setSelectedMessages] = useState({});
  const [submittedValues, setSubmittedValues] = useState({});
  const [messages, setMessages] = useState(() => [
    {
      id: "welcome",
      from: "bot",
      text: [
        "👋 Welcome to Dr. Khurrum Mansoor’s Appointment Assistant",
        "",
        "Please choose your preferred language.",
        "",
        "ڈاکٹر خرم منصور کے اپائنٹمنٹ اسسٹنٹ میں خوش آمدید",
        "",
        "براہِ کرم اپنی پسندیدہ زبان منتخب کریں۔"
      ].join("\n"),
      options: [
        { label: "English", value: "language_english" },
        { label: "اردو", value: "language_urdu" }
      ],
      timestamp: new Date().toISOString()
    }
  ]);

  const latestBotMessage = useMemo(() => [...messages].reverse().find((message) => message.from === "bot"), [messages]);
  const activeTask = taskForChatMessage(latestBotMessage, language);
  const currentStep = latestBotMessage ? bookingStep(latestBotMessage.text) : 0;
  const headerBackOption = latestBotMessage?.options?.find((item) => item.value === "navigation_back");

  useEffect(() => {
    localStorage.setItem("khurrum_chat_language", language);
    document.documentElement.lang = language;
    document.documentElement.dir = isRtl(language) ? "rtl" : "ltr";
  }, [language]);

  useEffect(() => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    messagesEndRef.current?.scrollIntoView({ behavior, block: "nearest" });
  }, [messages, typing]);

  useEffect(() => {
    setTaskError("");
    setActionError("");
    if (!activeTask || !latestBotMessage) return;
    const saved = submittedValues[activeTask.key] || (activeTask.key === "bookingPhone" ? phone : "");
    setInput(saved);
    window.setTimeout(() => composeInputRef.current?.focus(), 80);
  }, [latestBotMessage?.id, activeTask?.key]);

  useEffect(() => {
    if (isValidPhone(phone)) localStorage.setItem("khurrum_chat_phone", phone);
  }, [phone]);

  useEffect(() => {
    if (resumeAttemptedRef.current || !isValidPhone(phone)) return;
    resumeAttemptedRef.current = true;
    const controller = new AbortController();
    fetch("/api/public/chat/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, language }),
      signal: controller.signal
    })
      .then(readJson)
      .then((payload) => {
        if (!payload.reply) return;
        if (payload.reply.language) setLanguage(payload.reply.language);
        setMessages([{
          id: `resume-${Date.now()}`,
          from: "bot",
          text: payload.reply.text,
          options: payload.reply.options || [],
          nextStep: payload.reply.nextStep,
          inputConfig: payload.reply.input,
          consentRejected: Boolean(payload.reply.consentRejected),
          timestamp: new Date().toISOString()
        }]);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setActionError(language === "ur" ? "پچھلی گفتگو بحال نہیں ہو سکی۔" : "The previous conversation could not be restored.");
      });
    return () => {
      controller.abort();
      resumeAttemptedRef.current = false;
    };
  }, []);

  const addMessage = useCallback((message) => {
    const entry = { id: `${Date.now()}-${Math.random()}`, timestamp: new Date().toISOString(), ...message };
    setMessages((current) => [...current, entry]);
    return entry;
  }, []);

  const send = async (value, meta = {}) => {
    if (sendingRef.current) return false;
    const message = String(value || input).trim();
    if (!message) return false;
    if (!isValidPhone(phone)) {
      setPhoneError(language === "ur" ? "پہلے اپنا درست واٹس ایپ نمبر لکھیں۔" : "Enter your valid WhatsApp number first.");
      phoneRef.current?.focus();
      return false;
    }

    sendingRef.current = true;
    setTyping(true);
    setActionError("");
    setInput("");
    if (meta.sourceMessageId) setSelectedMessages((current) => ({ ...current, [meta.sourceMessageId]: meta.actionId || message }));
    const patientEntry = addMessage({ from: "patient", text: meta.displayText || message });

    try {
      const interactionId = meta.interactionId || crypto.randomUUID();
      const response = await fetch("/api/public/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          message,
          language,
          actionId: meta.actionId,
          interactionId,
          messageType: meta.messageType || "text"
        })
      });
      const payload = await readJson(response);
      if (payload.reply?.language) setLanguage(payload.reply.language);
      if (meta.sourceMessageId) {
        setCompletedMessages((current) => ({ ...current, [meta.sourceMessageId]: { value: meta.displayText || message, fieldKey: meta.fieldKey || "" } }));
      }
      if (meta.fieldKey) setSubmittedValues((current) => ({ ...current, [meta.fieldKey]: meta.displayText || message }));
      const replyType = payload.reply?.emergency ? "emergency" : payload.reply?.appointment ? "success" : "";
      addMessage({
        from: "bot",
        text: payload.reply.text,
        options: payload.reply.options || [],
        type: replyType,
        appointment: payload.reply.appointment,
        nextStep: payload.reply.nextStep,
        inputConfig: payload.reply.input,
        consentRejected: Boolean(payload.reply.consentRejected)
      });
      return true;
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== patientEntry.id));
      if (meta.sourceMessageId) setSelectedMessages((current) => ({ ...current, [meta.sourceMessageId]: "" }));
      setActionError(error.message || (language === "ur" ? "دوبارہ کوشش کریں۔" : "Please try again."));
      return false;
    } finally {
      sendingRef.current = false;
      setTyping(false);
    }
  };

  const submitTask = async (event) => {
    event.preventDefault();
    if (!activeTask || !latestBotMessage || typing) return;
    const error = activeTask.validate(input);
    if (error) {
      setTaskError(error);
      composeInputRef.current?.focus();
      return;
    }
    setTaskError("");
    await send(input, { displayText: input.trim(), sourceMessageId: latestBotMessage.id, fieldKey: activeTask.key });
  };

  const chooseOption = (message, item) => {
    const label = humanOptionLabel(item, language);
    const interactionKey = `${message.id}:${item.value}`;
    const interactionId = interactionIdsRef.current.get(interactionKey) || crypto.randomUUID();
    interactionIdsRef.current.set(interactionKey, interactionId);
    const displayText = item.value === "consent_accept" ? `✅ ${label}` : label;
    send(item.value, {
      actionId: item.value,
      displayText,
      interactionId,
      messageType: "poll_selection",
      sourceMessageId: message.id
    });
  };

  const returnToMenu = async () => {
    setShowExitConfirm(false);
    setMenuOpen(false);
    await send("main_menu", { displayText: language === "ur" ? "مین مینو پر واپس جائیں" : "Return to Main Menu", sourceMessageId: latestBotMessage?.id });
  };

  return (
    <main className="patient-chat-page">
      <header className="patient-chat-top">
        <div className="sidebar-brand">
          <div className="brand-icon"><MessageCircle size={24} /></div>
          <div><strong>{DOCTOR}</strong><span>WhatsApp appointment assistant</span></div>
        </div>
        <div className="patient-top-actions">
          <LanguageSwitch language={language} setLanguage={setLanguage} />
          <a href="/" className="ghost-link">Staff Login</a>
        </div>
      </header>

      <section className="phone-shell">
        <header className="chat-header">
          <div className="chat-header-main">
            {headerBackOption && currentStep > 0 && (
              <button className="chat-header-back" type="button" aria-label={language === "ur" ? "واپس" : "Back"} onClick={() => chooseOption(latestBotMessage, headerBackOption)} disabled={typing}>
                <ChevronLeft size={20} />
              </button>
            )}
            <div className="chat-avatar"><MessageCircle size={20} /></div>
            <div className="chat-identity">
              <strong>{DOCTOR}</strong>
              <small>Consultant Gynecologist</small>
              <span>Appointment Assistant</span>
            </div>
            <span className="assistant-label"><ShieldCheck size={13} /><span>Secure Assistant</span></span>
            <button className="chat-menu-button" type="button" aria-label="Booking options" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <MoreVertical size={20} />
            </button>
          </div>
          {currentStep > 0 && (
            <div className="header-booking-progress">
              <span>{bookingStepName(currentStep, language)} · {language === "ur" ? `مرحلہ ${currentStep} از 6` : `Step ${currentStep} of 6`}</span>
              <BookingProgress step={currentStep} />
            </div>
          )}
          {menuOpen && (
            <div className="chat-overflow-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setShowExitConfirm(true); }}>
                <LogOut size={16} /> {language === "ur" ? "مین مینو پر واپس جائیں" : "Return to Main Menu"}
              </button>
            </div>
          )}
        </header>

        <div className={`chat-phone-input ${phoneError ? "has-error" : ""}`}>
          <Phone size={17} aria-hidden="true" />
          <label className="session-phone-field">
            <span>{language === "ur" ? "آپ کا واٹس ایپ نمبر" : "Your WhatsApp number"}</span>
            <input ref={phoneRef} value={phone} onChange={(event) => { setPhone(event.target.value); setPhoneError(""); }} aria-describedby={phoneError ? "session-phone-error" : undefined} aria-invalid={Boolean(phoneError)} placeholder="+92 300 1234567" inputMode="tel" autoComplete="tel" />
          </label>
          <span className={isValidPhone(phone) ? "phone-valid" : "phone-invalid"}>{isValidPhone(phone) ? (language === "ur" ? "تیار" : "Ready") : (language === "ur" ? "درکار" : "Required")}</span>
          {phoneError && <small id="session-phone-error" className="inline-field-error">{phoneError}</small>}
        </div>

        <div className="chat-thread" aria-live="polite" aria-busy={typing}>
          {messages.map((message) => {
            const task = taskForChatMessage(message, language);
            const isLatest = message.id === latestBotMessage?.id;
            const completed = completedMessages[message.id];
            const step = bookingStep(message.text);
            const isConsentCard = (message.options || []).some((item) => item.value === "consent_accept");
            const options = (message.options || []).filter((item) => {
              if (item.value === "navigation_back") return false;
              if (item.value === "main_menu" && !message.consentRejected) return false;
              return !(step === 6 && item.value === "booking_cancel");
            });
            const backOption = (message.options || []).find((item) => item.value === "navigation_back");
            const selected = selectedMessages[message.id] || "";

            return (
              <article key={message.id} className={`chat-message ${message.from} ${message.type || ""} ${task ? "task-prompt" : ""} ${isConsentCard ? "consent-card" : ""}`}>
                {message.from === "bot" && bookingStep(message.text) > 0 && !currentStep && <BookingProgress step={bookingStep(message.text)} />}
                <p>{cleanChatText(message.text)}</p>
                {options.length > 0 && (
                  <div className={`chat-options ${optionLayout(options)}`}>
                    {options.map((item) => {
                      const label = humanOptionLabel(item, language);
                      const isSelected = selected === item.value;
                      return (
                        <button key={`${message.id}-${item.value}`} className={`${isSelected ? "selected" : ""} ${isPrimaryChatAction(item.value) ? "primary-choice" : ""}`} type="button" onClick={() => chooseOption(message, item)} disabled={typing || !isLatest || Boolean(completed)} aria-pressed={isSelected}>
                          <span className="quick-icon"><ChatOptionIcon action={item.value} /></span>
                          <span><strong>{label}</strong>{item.description && <small>{item.description}</small>}</span>
                          {isSelected && <CheckCircle2 className="selected-check" size={18} />}
                        </button>
                      );
                    })}
                  </div>
                )}
                {backOption && isLatest && !completed && (
                  <button className="task-back-button message-back" type="button" onClick={() => chooseOption(message, backOption)} disabled={typing}>
                    <ChevronLeft size={16} />{step === 6 ? (language === "ur" ? "تاریخ یا وقت تبدیل کریں" : "Change Date or Time") : humanOptionLabel(backOption, language)}
                  </button>
                )}
                <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
              </article>
            );
          })}
          {actionError && <div className="inline-chat-alert" role="alert">{actionError}</div>}
          {typing && <div className="chat-message bot typing" aria-label={language === "ur" ? "اسسٹنٹ جواب دے رہا ہے" : "Assistant is responding"}><span /><span /><span /></div>}
          <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
        </div>

        <footer className="chat-footer">
          {taskError && <div className="compose-error inline-field-error" role="alert">{taskError}</div>}
          <form className="chat-compose" onSubmit={activeTask ? submitTask : (event) => { event.preventDefault(); send(input, { displayText: input }); }} noValidate>
            <button className="attachment-button" type="button" aria-label={language === "ur" ? "فائل منسلک کریں" : "Attach a file"} title={language === "ur" ? "فائل منسلک کرنا دستیاب نہیں" : "File attachments are not available"} disabled>
              <Paperclip size={18} />
            </button>
            <input
              ref={composeInputRef}
              value={input}
              onChange={(event) => { setInput(event.target.value); setTaskError(""); }}
              aria-label={activeTask?.question || (language === "ur" ? "پیغام لکھیں" : "Type a message")}
              aria-invalid={Boolean(taskError)}
              placeholder={latestBotMessage?.inputConfig?.placeholder || activeTask?.placeholder || (language === "ur" ? "اپنا پیغام لکھیں…" : "Type your message…")}
              inputMode={latestBotMessage?.inputConfig?.inputMode || activeTask?.inputMode || "text"}
              autoComplete={latestBotMessage?.inputConfig?.autoComplete || activeTask?.autoComplete || "off"}
              disabled={typing}
            />
            <button className="send-button" aria-label={language === "ur" ? "پیغام بھیجیں" : "Send message"} disabled={typing || !input.trim()}><Send size={18} /></button>
          </form>
          <div className="chat-privacy"><LockKeyhole size={13} />{language === "ur" ? "آپ کی معلومات محفوظ طریقے سے بھیجی جاتی ہیں۔" : "Your details are sent securely."}</div>
        </footer>

        {showExitConfirm && (
          <div className="chat-dialog-backdrop" role="presentation">
            <div className="chat-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-booking-title">
              <h3 id="exit-booking-title">{language === "ur" ? "بکنگ چھوڑ دیں؟" : "Exit this booking?"}</h3>
              <p>{language === "ur" ? "درج شدہ معلومات محفوظ نہیں رہیں گی۔" : "Your current booking progress will be cleared."}</p>
              <button className="secondary-button" type="button" onClick={() => setShowExitConfirm(false)}>{language === "ur" ? "بکنگ جاری رکھیں" : "Continue Booking"}</button>
              <button className="danger-link" type="button" onClick={returnToMenu}>{language === "ur" ? "مین مینو پر واپس جائیں" : "Return to Main Menu"}</button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function BookingProgress({ step }) {
  return <div className="booking-progress" role="progressbar" aria-valuemin="1" aria-valuemax="6" aria-valuenow={step} aria-label={`Booking step ${step} of 6`}><span style={{ width: `${(step / 6) * 100}%` }} /></div>;
}

function ChatOptionIcon({ action = "" }) {
  if (action.includes("book")) return <Calendar size={16} />;
  if (action.includes("check")) return <Search size={16} />;
  if (action.includes("reschedule")) return <RefreshCw size={16} />;
  if (action.includes("cancel")) return <XCircle size={16} />;
  if (action.includes("clinic")) return <MapPin size={16} />;
  if (action.includes("doctor")) return <UserRound size={16} />;
  if (action.includes("reception")) return <Phone size={16} />;
  if (action.includes("emergency")) return <ShieldCheck size={16} />;
  if (action.includes("language")) return <Languages size={16} />;
  if (action.startsWith("date_")) return <Calendar size={16} />;
  if (action.includes("slot") || action.includes("time")) return <Clock size={16} />;
  if (action.includes("consent") || action.includes("confirm")) return <CheckCircle2 size={16} />;
  return <MessageCircle size={16} />;
}

function LanguageSwitch({ language, setLanguage }) {
  return (
    <div className="language-selector compact">
      <span className="language-label">
        <Languages size={16} />
        Language
      </span>
      <div className="language-options">
        <button className={language === "en" ? "active" : ""} type="button" onClick={() => setLanguage("en")}>
          English
        </button>
        <button className={language === "ur" ? "active" : ""} type="button" onClick={() => setLanguage("ur")}>
          اردو
        </button>
      </div>
    </div>
  );
}

function DetailGrid({ items }) {
  return (
    <dl className="detail-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose}>
            <XCircle size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
