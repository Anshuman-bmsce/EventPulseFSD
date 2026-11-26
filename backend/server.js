const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { Firestore, FieldValue } = require("@google-cloud/firestore");
const { PubSub } = require("@google-cloud/pubsub");
const { Storage } = require("@google-cloud/storage");
const { v4: uuidv4 } = require("uuid");
const { createConsumer } = require("./consumer/consumer");
const { validateEvent } = require("./consumer/validator");
const { log } = require("./consumer/logger");
const { assignments } = require("./assignments");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "eventpulse-demo";
const TOPIC_NAME = process.env.PUBSUB_TOPIC || "eventpulse-events";
const SUB_NAME = process.env.PUBSUB_SUBSCRIPTION || "eventpulse-consumer";
const BUCKET_NAME = process.env.SUBMISSIONS_BUCKET || "eventpulse-submissions";
const PORT = Number(process.env.PORT || 8081);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ADMIN_ID = process.env.EVENTPULSE_ADMIN_ID || "EP-ADMIN-2026";

function requireAdmin(req, res, next) {
  const supplied = req.get("x-admin-id");
  if (!supplied || supplied !== ADMIN_ID) return res.status(401).json({ error: "Admin ID is invalid. Admin access is required." });
  next();
}

const firestore = new Firestore({ projectId: PROJECT_ID });
const pubsub = new PubSub({ projectId: PROJECT_ID });
const storage = new Storage({ projectId: PROJECT_ID });
const consumeMessage = createConsumer(firestore, MAX_RETRIES);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const hasPdfName = path.extname(file.originalname || "").toLowerCase() === ".pdf";
    if (!["application/pdf", "application/octet-stream", ""].includes(file.mimetype) || !hasPdfName) {
      return callback(new Error("Only PDF files are accepted. Please select a .pdf file."));
    }
    callback(null, true);
  }
});

let topic;
let subscription;
let subscriberStarted = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureMessaging() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      topic = pubsub.topic(TOPIC_NAME);
      const [topicExists] = await topic.exists();
      if (!topicExists) await topic.create();

      const sub = pubsub.subscription(SUB_NAME);
      const [subExists] = await sub.exists();
      if (!subExists) await topic.createSubscription(SUB_NAME);
      subscription = pubsub.subscription(SUB_NAME);

      log("INFO", "Pub/Sub topic and subscription are ready", { topic: TOPIC_NAME, subscription: SUB_NAME });
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      log("WARNING", "Waiting for FLOCI Pub/Sub", { attempt, error: error.message });
      await delay(2000);
    }
  }
}

async function ensureStorageBucket() {
  const bucket = storage.bucket(BUCKET_NAME);
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const [exists] = await bucket.exists();
      if (!exists) {
        try {
          await bucket.create({ location: "US" });
        } catch (error) {
          // Another backend instance may have created it between exists() and create().
          const [createdByAnotherInstance] = await bucket.exists();
          if (!createdByAnotherInstance) throw error;
        }
      }
      log("INFO", "PDF storage bucket is ready", { bucket: BUCKET_NAME });
      return bucket;
    } catch (error) {
      if (attempt === 30) throw error;
      log("WARNING", "Waiting for FLOCI Cloud Storage", { attempt, error: error.message });
      await delay(2000);
    }
  }
}

async function startSubscriber() {
  if (subscriberStarted) return;
  await ensureMessaging();
  subscription.on("message", consumeMessage);
  subscription.on("error", error => log("ERROR", "Pub/Sub subscriber error", { error: error.message }));
  subscriberStarted = true;
  log("INFO", "EventPulse Pub/Sub consumer started", { subscription: SUB_NAME });
}

function cleanFilename(name) {
  const base = path.basename(name || "assignment.pdf").normalize("NFKC");
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "assignment.pdf";
}

function submissionId(studentId, activityId) {
  return `${studentId}__${activityId}`;
}

function serializeDoc(doc) {
  const value = doc.data();
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item.toDate === "function") value[key] = item.toDate().toISOString();
  }
  return { id: doc.id, ...value };
}

function validIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "eventpulse-backend",
  messaging: subscriberStarted,
  storage_bucket: BUCKET_NAME,
  local_emulator: Boolean(process.env.PUBSUB_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST)
}));

app.get("/api/assignments", (_req, res) => res.json(assignments));

// The student's action is the event producer: PDF -> Cloud Storage -> Pub/Sub -> consumer -> Firestore.
app.post("/api/submissions", upload.single("file"), async (req, res) => {
  let uploadedObject;
  let event;
  let eventPublished = false;
  try {
    const { student_id: studentId, student_name: studentName, activity_id: activityId } = req.body;
    if (!validIdentifier(studentId)) {
      return res.status(400).json({ error: "Enter a valid student ID (letters, numbers, hyphens or underscores)." });
    }
    if (typeof studentName !== "string" || !studentName.trim() || studentName.trim().length > 80) {
      return res.status(400).json({ error: "Enter your name (up to 80 characters)." });
    }
    const assignment = assignments.find(item => item.activity_id === activityId);
    if (!assignment) return res.status(400).json({ error: "Please select a valid assignment." });
    if (!req.file) return res.status(400).json({ error: "Choose a PDF file before submitting." });

    // Extension and browser MIME type are not trusted on their own; verify the PDF signature too.
    if (req.file.buffer.length < 5 || req.file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return res.status(415).json({ error: "The selected file is not a valid PDF. Please upload a real PDF document." });
    }

    const eventId = `EVT-${uuidv4()}`;
    const safeName = cleanFilename(req.file.originalname);
    const objectName = `submissions/${studentId}/${activityId}/${eventId}.pdf`;
    const pdfObject = storage.bucket(BUCKET_NAME).file(objectName);

    event = {
      event_id: eventId,
      event_type: "assignment_submitted",
      schema_version: "1.0",
      timestamp: new Date().toISOString(),
      student_id: studentId,
      activity_id: activityId,
      data: {
        status: "submitted",
        student_name: studentName.trim(),
        assignment_title: assignment.title,
        file_name: safeName,
        file_size: req.file.size,
        content_type: "application/pdf",
        object_name: objectName
      }
    };

    await pdfObject.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: "application/pdf",
        cacheControl: "private, no-store",
        metadata: { student_id: studentId, activity_id: activityId, event_id: eventId, original_file_name: safeName }
      }
    });
    uploadedObject = pdfObject;

    const validationError = validateEvent(event);
    if (validationError) {
      await pdfObject.delete({ ignoreNotFound: true }).catch(() => {});
      return res.status(400).json({ error: validationError });
    }

    await firestore.collection("submission_requests").doc(eventId).set({
      event_id: eventId,
      student_id: studentId,
      student_name: studentName.trim(),
      activity_id: activityId,
      assignment_title: assignment.title,
      file_name: safeName,
      file_size: req.file.size,
      content_type: "application/pdf",
      object_name: objectName,
      status: "queued",
      notification_title: "Submission received",
      notification_message: "Your PDF is stored securely and queued for event processing.",
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp()
    });

    const messageId = await topic.publishMessage({ json: event });
    eventPublished = true;
    await firestore.collection("submission_requests").doc(eventId).set({
      pubsub_message_id: messageId,
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true }).catch(error => log("WARNING", "Could not save Pub/Sub message ID", { event_id: eventId, error: error.message }));

    log("INFO", "Student submission stored and event published", {
      event_id: eventId, student_id: studentId, activity_id: activityId,
      file_size: req.file.size, bucket: BUCKET_NAME, object_name: objectName, pubsub_message_id: messageId
    });

    return res.status(202).json({
      message: "Your PDF was received and sent for processing.",
      event_id: eventId,
      status: "queued"
    });
  } catch (error) {
    if (eventPublished && event?.event_id) {
      // Pub/Sub accepted the event. Do not delete its PDF or report it as failed;
      // the consumer remains responsible for the final status.
      log("WARNING", "Submission was published but the HTTP response path had a follow-up error", { event_id: event.event_id, error: error.message });
      return res.status(202).json({ message: "Your assignment was queued for processing.", event_id: event.event_id, status: "queued" });
    }
    if (uploadedObject) await uploadedObject.delete({ ignoreNotFound: true }).catch(() => {});
    if (event?.event_id) {
      await firestore.collection("submission_requests").doc(event.event_id).set({
        event_id: event.event_id,
        student_id: event.student_id,
        student_name: event.data.student_name,
        activity_id: event.activity_id,
        assignment_title: event.data.assignment_title,
        file_name: event.data.file_name,
        file_size: event.data.file_size,
        content_type: event.data.content_type,
        status: "failed",
        notification_title: "Submission could not be queued",
        notification_message: "The server could not store or queue your assignment. Please try again.",
        failure_reason: error.message,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      await firestore.collection("failed_events").doc(`PRODUCER-${event.event_id}`).set({
        event_id: event.event_id,
        student_id: event.student_id,
        activity_id: event.activity_id,
        event,
        status: "failed",
        reason: `Producer/storage/publish failure: ${error.message}`,
        attempts: 1,
        retry_count: 0,
        failed_at: FieldValue.serverTimestamp()
      }).catch(() => {});
    }
    log("ERROR", "Assignment submission request failed", { error: error.message, event_id: event?.event_id || null });
    return res.status(503).json({ error: "We could not send your assignment for processing. Please try again.", detail: error.message });
  }
});

app.get("/api/submissions/:eventId", async (req, res) => {
  try {
    const studentId = req.query.student_id;
    if (!studentId) return res.status(400).json({ error: "Student ID is required." });
    const snapshot = await firestore.collection("submission_requests").doc(req.params.eventId).get();
    if (!snapshot.exists || snapshot.data().student_id !== studentId) return res.status(404).json({ error: "Submission status was not found for this student." });
    return res.json(serializeDoc(snapshot));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/student/:studentId/submissions", async (req, res) => {
  try {
    if (!validIdentifier(req.params.studentId)) return res.status(400).json({ error: "Invalid student ID." });
    const snapshot = await firestore.collection("submission_requests").where("student_id", "==", req.params.studentId).limit(100).get();
    return res.json(snapshot.docs.map(serializeDoc).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)));
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.get("/api/submissions", requireAdmin, async (_req, res) => {
  try {
    const snapshot = await firestore.collection("submission_requests").orderBy("created_at", "desc").limit(100).get();
    return res.json(snapshot.docs.map(serializeDoc));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/activities", requireAdmin, async (_req, res) => {
  try {
    const snapshot = await firestore.collection("student_activities").orderBy("updated_at", "desc").limit(100).get();
    return res.json(snapshot.docs.map(serializeDoc));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/events", requireAdmin, async (_req, res) => {
  try {
    const [processed, failed, duplicates] = await Promise.all([
      firestore.collection("processed_events").orderBy("processed_at", "desc").limit(100).get(),
      firestore.collection("failed_events").limit(100).get(),
      firestore.collection("duplicate_events").limit(100).get()
    ]);
    return res.json({
      processed: processed.docs.filter(doc => doc.data().status === "processed").map(serializeDoc),
      failed: failed.docs.map(serializeDoc),
      duplicates: duplicates.docs.map(serializeDoc)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/stats", requireAdmin, async (_req, res) => {
  try {
    const [activities, processed, failed, duplicates, submissions] = await Promise.all([
      firestore.collection("student_activities").get(),
      firestore.collection("processed_events").where("status", "==", "processed").get(),
      firestore.collection("failed_events").get(),
      firestore.collection("duplicate_events").get(),
      firestore.collection("submission_requests").get()
    ]);
    const pending = submissions.docs.filter(doc => ["queued", "processing"].includes(doc.data().status)).length;
    return res.json({
      activities: activities.size,
      processed: processed.size,
      failed: failed.size,
      duplicates: duplicates.size,
      pending,
      total: submissions.size
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Instructor/demo-only failure hooks are retained for repeatable failure-path testing.
function createTestEvent(studentId, activityId, mode) {
  return {
    event_id: `${mode.toUpperCase()}-${uuidv4()}`,
    event_type: "assignment_submitted",
    schema_version: "1.0",
    timestamp: new Date().toISOString(),
    student_id: studentId,
    activity_id: activityId,
    data: {
      status: "submitted", student_name: "Demo Student", assignment_title: "Failure-path test",
      file_name: "demo-test.pdf", file_size: 128, content_type: "application/pdf",
      object_name: `submissions/demo/${mode}.pdf`, [`simulate_${mode}_failure`]: true
    }
  };
}

app.post("/api/test/temporary-failure", requireAdmin, async (_req, res) => {
  try {
    const event = createTestEvent("DEMO102", "EVENT-202", "temporary");
    const eventId = event.event_id;
    await firestore.collection("submission_requests").doc(eventId).set({
      event_id: eventId, student_id: event.student_id, activity_id: event.activity_id,
      assignment_title: event.data.assignment_title, file_name: event.data.file_name, status: "queued",
      notification_title: "Demo event queued", notification_message: "Temporary failure test is running.",
      created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp()
    });
    await topic.publishMessage({ json: event });
    return res.status(202).json({ event_id: eventId, status: "queued" });
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
});

app.post("/api/test/permanent-failure", requireAdmin, async (_req, res) => {
  try {
    const event = createTestEvent("DEMO103", "FIRE-303", "permanent");
    const eventId = event.event_id;
    await firestore.collection("submission_requests").doc(eventId).set({
      event_id: eventId, student_id: event.student_id, activity_id: event.activity_id,
      assignment_title: event.data.assignment_title, file_name: event.data.file_name, status: "queued",
      notification_title: "Demo event queued", notification_message: "Permanent failure test is running.",
      created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp()
    });
    await topic.publishMessage({ json: event });
    return res.status(202).json({ event_id: eventId, status: "queued" });
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
});

app.post("/api/test/malformed", requireAdmin, async (_req, res) => {
  try {
    const event = { event_id: `BAD-${uuidv4()}`, event_type: "assignment_submitted" };
    const messageId = await topic.publishMessage({ json: event });
    return res.status(202).json({ message: "Malformed test event published", message_id: messageId });
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Your PDF is larger than 10 MB. Please upload a smaller PDF." });
  }
  if (error.message?.includes("Only PDF files")) return res.status(415).json({ error: error.message });
  log("ERROR", "Unhandled API error", { error: error.message });
  return res.status(500).json({ error: "Something went wrong while handling your request." });
});

(async () => {
  try {
    await Promise.all([ensureMessaging(), ensureStorageBucket()]);
    await startSubscriber();
    app.listen(PORT, "0.0.0.0", () => log("INFO", "EventPulse API listening", {
      port: PORT, project: PROJECT_ID, topic: TOPIC_NAME, bucket: BUCKET_NAME,
      pubsub_emulator: process.env.PUBSUB_EMULATOR_HOST || "Google Cloud Pub/Sub",
      firestore_emulator: process.env.FIRESTORE_EMULATOR_HOST || "Google Cloud Firestore",
      storage_emulator: process.env.STORAGE_EMULATOR_HOST || "Google Cloud Storage"
    }));
  } catch (error) {
    log("FATAL", "Startup failed", { error: error.message });
    process.exit(1);
  }
})();
