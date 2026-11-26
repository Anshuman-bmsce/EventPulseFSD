function validateEvent(event) {
  const required = ["event_id", "event_type", "schema_version", "timestamp", "student_id", "activity_id"];

  if (!event || typeof event !== "object" || Array.isArray(event)) return "Invalid event object";

  const missing = required.filter(key => typeof event[key] !== "string" || !event[key].trim());
  if (missing.length) return `Missing or invalid fields: ${missing.join(", ")}`;
  if (event.schema_version !== "1.0") return "Unsupported schema version";
  if (Number.isNaN(Date.parse(event.timestamp))) return "Invalid timestamp";
  if (event.event_type !== "assignment_submitted") return "Unsupported event type";

  for (const key of ["event_id", "student_id", "activity_id"]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(event[key])) return `Invalid ${key}`;
  }

  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    return "Missing or invalid event data";
  }

  if (event.data.status !== "submitted") return "Invalid submission status";
  if (typeof event.data.object_name !== "string" || !event.data.object_name.startsWith("submissions/")) {
    return "Missing or invalid PDF storage object";
  }
  if (event.data.content_type !== "application/pdf") return "Only PDF submissions are accepted";
  if (typeof event.data.file_name !== "string" || !event.data.file_name.toLowerCase().endsWith(".pdf")) {
    return "Invalid PDF filename";
  }
  if (!Number.isInteger(event.data.file_size) || event.data.file_size < 1) return "Invalid PDF file size";
  if (event.data.file_size > 10 * 1024 * 1024) return "PDF exceeds the 10 MB limit";

  return null;
}

module.exports = { validateEvent };
