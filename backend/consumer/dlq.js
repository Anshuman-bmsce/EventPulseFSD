const { FieldValue } = require("@google-cloud/firestore");
const { log } = require("./logger");

async function recordFailedEvent(firestore, event, reason, status, attempts, messageId) {
  const documentId = `MSG-${messageId}`;
  const normalizedStatus = status === "rejected" ? "rejected" : "failed";
  const friendlyMessage = normalizedStatus === "rejected"
    ? "Your submission could not be accepted because its event data was invalid. Please check the PDF and try again."
    : "We could not process your submission after retrying. Your file was not recorded as submitted. Please try again.";

  await firestore.collection("failed_events").doc(documentId).set({
    event_id: typeof event?.event_id === "string" ? event.event_id : null,
    message_id: messageId,
    student_id: event?.student_id || null,
    activity_id: event?.activity_id || null,
    event: event ?? null,
    status: normalizedStatus,
    reason,
    retry_count: Math.max(0, attempts - 1),
    attempts,
    failed_at: FieldValue.serverTimestamp()
  });

  if (typeof event?.event_id === "string") {
    await firestore.collection("submission_requests").doc(event.event_id).set({
      status: normalizedStatus,
      notification_title: normalizedStatus === "rejected" ? "Submission rejected" : "Submission failed",
      notification_message: friendlyMessage,
      failure_reason: reason,
      attempts,
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  log("ERROR", "Event moved to failure quarantine", {
    event_id: event?.event_id || null,
    status: normalizedStatus,
    reason,
    attempts
  });
}

module.exports = { recordFailedEvent };
