const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@google-cloud/firestore") {
    return {
      FieldValue: {
        serverTimestamp: () => new Date("2026-01-01T00:00:00.000Z"),
        increment: amount => ({ __increment: amount })
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { validateEvent } = require("../consumer/validator");
const { processIdempotentEvent } = require("../consumer/idempotency");

class FakeFirestore {
  constructor() { this.data = new Map(); }
  collection(name) {
    return {
      doc: id => ({ collection: name, id })
    };
  }
  async runTransaction(callback) {
    const tx = {
      get: async ref => ({ exists: this.data.has(`${ref.collection}/${ref.id}`), data: () => this.data.get(`${ref.collection}/${ref.id}`) }),
      set: (ref, value, options) => {
        const key = `${ref.collection}/${ref.id}`;
        const next = options?.merge ? { ...(this.data.get(key) || {}), ...value } : value;
        this.data.set(key, next);
      },
      create: (ref, value) => {
        const key = `${ref.collection}/${ref.id}`;
        if (this.data.has(key)) throw new Error(`Document already exists: ${key}`);
        this.data.set(key, value);
      }
    };
    return callback(tx);
  }
  read(collection, id) { return this.data.get(`${collection}/${id}`); }
  count(collection) { return [...this.data.keys()].filter(key => key.startsWith(`${collection}/`)).length; }
}

function event(eventId, studentId = "STU101", activityId = "CLOUD-101", fileName = "assignment.pdf") {
  return {
    event_id: eventId,
    event_type: "assignment_submitted",
    schema_version: "1.0",
    timestamp: "2026-11-26T10:00:00.000Z",
    student_id: studentId,
    activity_id: activityId,
    data: {
      status: "submitted",
      student_name: "Demo Student",
      assignment_title: "Cloud Computing Fundamentals",
      file_name: fileName,
      file_size: 1234,
      content_type: "application/pdf",
      object_name: `submissions/${studentId}/${activityId}/${eventId}.pdf`
    }
  };
}

test("event schema accepts a valid PDF submission event", () => {
  assert.equal(validateEvent(event("EVT-1")), null);
});

test("event schema rejects non-PDF content", () => {
  const invalid = event("EVT-2");
  invalid.data.content_type = "image/png";
  assert.match(validateEvent(invalid), /Only PDF/);
});

test("one successful submission per student and assignment; repeat attempt is duplicate", async () => {
  const db = new FakeFirestore();
  const first = event("EVT-FIRST");
  const firstResult = await processIdempotentEvent(db, first);
  assert.equal(firstResult.status, "processed");
  assert.equal(db.count("student_submissions"), 1);

  const second = event("EVT-SECOND", "STU101", "CLOUD-101", "another-copy.pdf");
  const duplicateResult = await processIdempotentEvent(db, second);
  assert.equal(duplicateResult.status, "duplicate");
  assert.equal(db.count("student_submissions"), 1);
  assert.equal(db.count("duplicate_events"), 1);
  assert.equal(db.read("submission_requests", "EVT-SECOND").status, "duplicate");
  assert.equal(db.read("student_submissions", "STU101__CLOUD-101").event_id, "EVT-FIRST");
});

test("Pub/Sub redelivery with the same event ID is ignored without counting a student duplicate", async () => {
  const db = new FakeFirestore();
  const first = event("EVT-REPLAY");
  await processIdempotentEvent(db, first);
  const replay = await processIdempotentEvent(db, first);
  assert.equal(replay.status, "redelivery");
  assert.equal(db.count("student_submissions"), 1);
  assert.equal(db.count("duplicate_events"), 0);
});

Module._load = originalLoad;
