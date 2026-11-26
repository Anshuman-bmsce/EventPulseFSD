import React, { useEffect, useMemo, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8081";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {})
  };
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatDate(value) {
  if (!value) return "Just now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Just now" : date.toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function statusLabel(status) {
  return ({
    processed: "Successful",
    duplicate: "Duplicate",
    failed: "Failed",
    rejected: "Rejected",
    queued: "Queued",
    processing: "Processing"
  })[status] || status || "Pending";
}

function StatusPill({ status }) {
  return <span className={`status-pill ${status || "queued"}`}>{statusLabel(status)}</span>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.type || "info"}`} role="status" aria-live="polite">
      <span className="toast-icon">{toast.type === "success" ? "✓" : toast.type === "warning" ? "!" : toast.type === "error" ? "×" : "i"}</span>
      <div><strong>{toast.title}</strong><p>{toast.message}</p></div>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss notification">×</button>
    </div>
  );
}

export default function App() {
  const [assignments, setAssignments] = useState([]);
  const [studentId, setStudentId] = useState("");
  const [role, setRole] = useState("student");
  const [adminId, setAdminId] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [studentName, setStudentName] = useState("");
  const [activityId, setActivityId] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [connection, setConnection] = useState("connecting");
  const [stats, setStats] = useState({ activities: 0, processed: 0, failed: 0, duplicates: 0, pending: 0, total: 0 });
  const [submissions, setSubmissions] = useState([]);
  const [events, setEvents] = useState({ processed: [], failed: [], duplicates: [] });
  const [activeSubmission, setActiveSubmission] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef(null);

  const selectedAssignment = useMemo(
    () => assignments.find(item => item.activity_id === activityId),
    [assignments, activityId]
  );

  async function refresh() {
    try {
      const assignmentData = await request("/api/assignments");
      setAssignments(assignmentData);
      setActivityId(current => current || assignmentData[0]?.activity_id || "");
      if (role === "admin" && adminUnlocked) {
        const headers = { "x-admin-id": adminId };
        const [submissionData, eventData, statsData] = await Promise.all([
          request("/api/submissions", { headers }), request("/api/events", { headers }), request("/api/stats", { headers })
        ]);
        setSubmissions(submissionData); setEvents(eventData); setStats(statsData); setAdminError("");
      } else if (role === "student" && studentId.trim()) {
        setSubmissions(await request(`/api/student/${encodeURIComponent(studentId.trim())}/submissions`));
      }
      setConnection("online");
    } catch (error) {
      if (role === "admin") setAdminError(error.message);
      setConnection("offline");
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3500);
    return () => window.clearInterval(timer);
  }, [role, adminUnlocked, adminId, studentId]);

  function validatePickedFile(candidate) {
    if (!candidate) return false;
    if (!["application/pdf", "application/octet-stream", ""].includes(candidate.type) || !candidate.name.toLowerCase().endsWith(".pdf")) {
      setToast({ type: "error", title: "PDF files only", message: "Please choose a file ending in .pdf. Word documents, images and other formats are not accepted." });
      return false;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setToast({ type: "error", title: "File is too large", message: "The maximum PDF size is 10 MB. Choose a smaller file and try again." });
      return false;
    }
    if (candidate.size === 0) {
      setToast({ type: "error", title: "Empty file", message: "This PDF is empty. Choose a valid document." });
      return false;
    }
    setToast(null);
    setFile(candidate);
    return true;
  }

  function handleFileInput(event) {
    validatePickedFile(event.target.files?.[0]);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragOver(false);
    validatePickedFile(event.dataTransfer.files?.[0]);
  }

  async function watchSubmission(eventId) {
    const terminal = new Set(["processed", "duplicate", "failed", "rejected"]);
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, 900));
      try {
        const status = await request(`/api/submissions/${encodeURIComponent(eventId)}?student_id=${encodeURIComponent(studentId.trim())}`);
        setActiveSubmission(status);
        if (terminal.has(status.status)) {
          const type = status.status === "processed" ? "success" : status.status === "duplicate" ? "warning" : "error";
          setToast({
            type,
            title: status.notification_title || statusLabel(status.status),
            message: status.notification_message || status.failure_reason || "The backend has finished handling your submission."
          });
          refresh();
          return status;
        }
      } catch (_error) {
        // Keep polling briefly; a freshly queued request can take a moment to appear in Firestore.
      }
    }
    setToast({
      type: "info",
      title: "Still processing",
      message: "Your submission is queued. You can keep this page open; the status panel will update when the backend finishes."
    });
    refresh();
    return null;
  }

  async function submitAssignment(event) {
    event.preventDefault();
    if (busy) return;
    if (!studentId.trim() || !studentName.trim() || !activityId || !file) {
      setToast({ type: "error", title: "Complete the submission details", message: "Enter your student ID and name, choose an assignment, and attach a PDF." });
      return;
    }

    setBusy(true);
    setToast({ type: "info", title: "Uploading PDF", message: "Your PDF is being securely uploaded and queued for processing." });
    setActiveSubmission({ status: "queued", file_name: file.name, assignment_title: selectedAssignment?.title });

    try {
      const form = new FormData();
      form.append("student_id", studentId.trim());
      form.append("student_name", studentName.trim());
      form.append("activity_id", activityId);
      form.append("file", file);
      const result = await request("/api/submissions", { method: "POST", body: form });
      setActiveSubmission({ event_id: result.event_id, status: "queued", file_name: file.name, assignment_title: selectedAssignment?.title });
      setToast({ type: "info", title: "Submission received", message: "FLOCI Pub/Sub has received the event. Waiting for the consumer's final result…" });
      const finalStatus = await watchSubmission(result.event_id);
      if (finalStatus && ["processed", "duplicate"].includes(finalStatus.status)) {
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch (error) {
      setActiveSubmission({ status: "failed", file_name: file.name });
      setToast({ type: "error", title: "Submission could not be completed", message: error.message });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const recentSubmissions = submissions.slice(0, 100);
  const notifications = submissions.filter(item => ["processed", "duplicate", "failed", "rejected"].includes(item.status)).slice(0, 8);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="EventPulse home">
          <span className="brand-mark">EP</span>
          <span>event<span>pulse</span><small>STUDENT SUBMISSION CLOUD</small></span>
        </a>
        <nav className="topnav"><button type="button" className={role === "student" ? "active" : ""} onClick={() => { setRole("student"); setAdminUnlocked(false); setToast(null); }}>Student</button><button type="button" className={role === "admin" ? "active" : ""} onClick={() => { setRole("admin"); setAdminUnlocked(false); setAdminError(""); }}>Admin</button></nav>
        <div className={`connection ${connection}`}><i />{connection === "online" ? "FLOCI connected" : connection === "offline" ? "Connecting…" : "Checking services…"}</div>
      </header>

      <section className="hero" id="home">
        <div className="hero-copy">
          <div className="eyebrow light"><span /> RELIABLE ASSIGNMENT DELIVERY</div>
          <h1>{role === "student" ? <>Your work. Your moment.<br /><em>Submit with confidence.</em></> : <>Behind every event,<br /><em>there is control.</em></>}</h1>
          <p>{role === "student" ? "Upload your assignment PDF. Track only your own submission result and notifications." : "Admin workspace for monitoring submissions, retries, duplicates and quarantined events."}</p>
          <div className="hero-points"><span><b>01</b> PDF validation</span><span><b>02</b> Pub/Sub processing</span><span><b>03</b> Instant status</span></div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="hero-document"><div className="pdf-badge">PDF</div><div className="doc-lines"><i /><i /><i /><i /></div><div className="doc-check">✓</div></div>
          <div className="float-chip chip-storage"><span>▤</span><div><b>Cloud Storage</b><small>File stored securely</small></div></div>
          <div className="float-chip chip-event"><span>↗</span><div><b>Pub/Sub event</b><small>Delivered to consumer</small></div></div>
        </div>
      </section>

      <Toast toast={toast} onClose={() => setToast(null)} />

      {role === "admin" && adminUnlocked && <section className="metric-grid" aria-label="Submission metrics">
        <article className="metric-card"><span className="metric-icon purple">↗</span><div><small>TOTAL ATTEMPTS</small><strong>{stats.total}</strong><span>Submissions received</span></div></article>
        <article className="metric-card"><span className="metric-icon green">✓</span><div><small>SUCCESSFUL</small><strong>{stats.processed}</strong><span>Processed assignments</span></div></article>
        <article className="metric-card"><span className="metric-icon red">!</span><div><small>FAILED / REJECTED</small><strong>{stats.failed}</strong><span>Needs student attention</span></div></article>
        <article className="metric-card"><span className="metric-icon amber">⟳</span><div><small>DUPLICATES BLOCKED</small><strong>{stats.duplicates}</strong><span>Repeated submissions</span></div></article>
      </section>}

      {role === "admin" && !adminUnlocked && <section className="panel submission-panel" style={{maxWidth:560,margin:"36px auto",padding:32}}><div className="eyebrow">RESTRICTED AREA</div><h2>Admin sign in</h2><p>Enter your authorised EventPulse admin ID to access monitoring and records.</p><form onSubmit={e => { e.preventDefault(); setAdminUnlocked(true); }}><label>Admin ID<input value={adminId} onChange={e => setAdminId(e.target.value)} placeholder="Enter admin ID" required /></label><button className="submit-button" type="submit">Unlock admin dashboard →</button>{adminError && <p className="tracker-message">{adminError}</p>}</form><small>Demo admin ID is configured in docker-compose.yml.</small></section>}

      {role === "student" && <section className="content-grid" id="submit">
        <div className="panel submission-panel">
          <div className="panel-heading"><div><div className="eyebrow">STUDENT PORTAL / 01</div><h2>Submit your assignment</h2><p>Complete the details below and upload your work as a PDF.</p></div><span className="secure-mark">⌑ Secure upload</span></div>

          <form onSubmit={submitAssignment}>
            <div className="form-row">
              <label>Student ID<input value={studentId} onChange={e => setStudentId(e.target.value)} placeholder="e.g. STU101" maxLength={64} required /></label>
              <label>Your name<input value={studentName} onChange={e => setStudentName(e.target.value)} placeholder="Enter your full name" maxLength={80} required /></label>
            </div>

            <label className="field-label">Choose an assignment</label>
            <div className="assignment-picker">
              {assignments.map((assignment, index) => (
                <button
                  type="button"
                  key={assignment.activity_id}
                  className={`assignment-option ${activityId === assignment.activity_id ? "selected" : ""}`}
                  onClick={() => setActivityId(assignment.activity_id)}
                >
                  <span className="assignment-number">0{index + 1}</span>
                  <span className="assignment-info"><b>{assignment.title}</b><small>{assignment.course} · {assignment.points} points</small></span>
                  <span className="radio-dot">{activityId === assignment.activity_id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
            {selectedAssignment && <div className="assignment-description">{selectedAssignment.description}</div>}

            <label className="field-label upload-label">Attach your assignment <span>PDF only · Maximum 10 MB</span></label>
            <div
              className={`upload-zone ${dragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
              onDragOver={event => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") fileInput.current?.click(); }}
            >
              <input ref={fileInput} type="file" accept=".pdf,application/pdf" onChange={handleFileInput} hidden />
              {file ? <>
                <span className="file-icon">PDF</span>
                <div className="upload-text"><b>{file.name}</b><small>{formatBytes(file.size)} · Ready to submit</small></div>
                <button type="button" className="remove-file" onClick={event => { event.stopPropagation(); setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove</button>
              </> : <>
                <span className="upload-icon">↑</span>
                <div className="upload-text"><b>Drop your PDF here or <u>browse files</u></b><small>Only PDF documents are accepted. Maximum file size: 10 MB.</small></div>
              </>}
            </div>

            <div className="form-footer"><div className="privacy-note"><span>♧</span> Your file is stored privately in the FLOCI Cloud Storage emulator.</div><button className="submit-button" type="submit" disabled={busy || connection !== "online" || ["queued", "processing"].includes(activeSubmission?.status)} >{busy ? <><span className="spinner" /> Processing…</> : <>Submit assignment <span>→</span></>}</button></div>
          </form>
        </div>

        <aside className="side-column">
          <div className="panel status-panel">
            <div className="eyebrow">LIVE SUBMISSION STATUS</div><h3>Submission tracker</h3>
            {activeSubmission ? <>
              <div className={`tracker-status ${activeSubmission.status || "queued"}`}><span>{activeSubmission.status === "processed" ? "✓" : activeSubmission.status === "duplicate" ? "↻" : activeSubmission.status === "failed" || activeSubmission.status === "rejected" ? "!" : "…"}</span><div><b>{statusLabel(activeSubmission.status)}</b><small>{activeSubmission.assignment_title || activeSubmission.file_name || "Your latest submission"}</small></div></div>
              {activeSubmission.event_id && <div className="event-id">EVENT ID <code>{activeSubmission.event_id}</code></div>}
              {activeSubmission.notification_message && <p className="tracker-message">{activeSubmission.notification_message}</p>}
              {!(["processed", "duplicate", "failed", "rejected"].includes(activeSubmission.status)) && <div className="progress-track"><i /></div>}
            </> : <div className="tracker-empty"><span>◎</span><b>No active submission</b><small>Your submission status will appear here after you upload a PDF.</small></div>}
            <div className="pipeline"><div className="pipeline-step done"><i>✓</i><span>PDF received</span></div><div className="pipeline-step"><i>2</i><span>Pub/Sub consumer</span></div><div className="pipeline-step"><i>3</i><span>Firestore result</span></div></div>
          </div>

          {role === "student" ? <div className="panel notifications-panel">
            <div className="panel-mini-head"><div><div className="eyebrow">STUDENT UPDATES</div><h3>Notifications</h3></div><span className="notification-count">{notifications.length}</span></div>
            {notifications.length === 0 ? <p className="empty-state">Your submission notifications will show here.</p> : notifications.map(item => (
              <div className="notification-item" key={item.event_id}><span className={`notification-symbol ${item.status}`}>{item.status === "processed" ? "✓" : item.status === "duplicate" ? "↻" : "!"}</span><div><b>{item.notification_title || statusLabel(item.status)}</b><small>{item.notification_message || item.failure_reason}</small><time>{formatDate(item.updated_at || item.created_at)}</time></div></div>
            ))}
          </div> : <div className="panel notifications-panel"><div className="eyebrow">ADMIN CONTROL ROOM</div><h3>Monitoring overview</h3><p className="empty-state">Use the admin sections below to review every submission, duplicate attempt and failed event.</p></div>}
        </aside>
      </section>}

      {role === "admin" && adminUnlocked && <><section className="panel activity-panel" id="activity">
        <div className="panel-heading"><div><div className="eyebrow">FIRESTORE / SUBMISSION RECORDS</div><h2>Recent submissions</h2><p>Each row reflects the backend result, not just a button click.</p></div><button className="refresh-button" onClick={refresh}>↻ Refresh</button></div>
        <div className="table-wrap"><table><thead><tr><th>STUDENT</th><th>ASSIGNMENT</th><th>PDF FILE</th><th>SUBMITTED</th><th>RESULT</th></tr></thead><tbody>
          {recentSubmissions.length === 0 ? <tr><td colSpan="5" className="empty-cell">No assignment submissions yet. Upload a PDF to create the first event.</td></tr> : recentSubmissions.map(item => (
            <tr key={item.event_id}><td><b>{item.student_name || item.student_id}</b><small>{item.student_id}</small></td><td>{item.assignment_title || item.activity_id}</td><td><span className="pdf-file">PDF</span>{item.file_name || "—"}</td><td>{formatDate(item.created_at)}</td><td><StatusPill status={item.status} /></td></tr>
          ))}
        </tbody></table></div>
      </section>

      <section className="event-grid" id="events">
        <div className="panel event-panel"><div className="eyebrow">PUB/SUB → FIRESTORE</div><h3>Processed events</h3>
          {events.processed.length === 0 ? <p className="empty-state">No successful events yet.</p> : events.processed.slice(0, 6).map(item => <div className="event-row" key={item.event_id}><span className="event-dot success-dot" /><div><b>{item.event_id}</b><small>{item.student_id} · {item.activity_id}</small></div><StatusPill status="processed" /></div>)}
        </div>
        <div className="panel event-panel"><div className="eyebrow">IDEMPOTENCY GUARD</div><h3>Duplicate attempts</h3>
          {events.duplicates.length === 0 ? <p className="empty-state">No duplicate attempts detected.</p> : events.duplicates.slice(0, 6).map(item => <div className="event-row" key={item.event_id}><span className="event-dot duplicate-dot" /><div><b>{item.student_id} · {item.activity_id}</b><small>Original: {item.original_event_id}</small></div><StatusPill status="duplicate" /></div>)}
        </div>
        <div className="panel event-panel"><div className="eyebrow">ERROR QUARANTINE</div><h3>Failed / rejected events</h3>
          {events.failed.length === 0 ? <p className="empty-state">No failed or rejected events.</p> : events.failed.slice(0, 6).map(item => <div className="event-row" key={item.id}><span className="event-dot failed-dot" /><div><b>{item.event_id || item.id}</b><small>{item.reason}</small></div><StatusPill status={item.status} /></div>)}
        </div>
      </section>

      </>}

      <footer><span className="brand-mark small-mark">EP</span><b>EventPulse</b><span>Reliable student submissions · React · Node.js · FLOCI · Pub/Sub · Firestore · Cloud Storage</span></footer>
    </main>
  );
}
