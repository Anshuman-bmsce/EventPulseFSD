const { validateEvent } = require("./validator");
const { processIdempotentEvent } = require("./idempotency");
const { retryOperation } = require("./retry");
const { recordFailedEvent } = require("./dlq");
const { log } = require("./logger");
const { FieldValue } = require("@google-cloud/firestore");

function createConsumer(firestore, maxAttempts = 3) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Invalid maximum attempts");

  return async function consumeMessage(message) {
    let event;
    try {
      try {
        event = JSON.parse(message.data.toString());
      } catch (_error) {
        await recordFailedEvent(firestore, null, "Invalid JSON message", "rejected", 0, message.id);
        message.ack();
        return;
      }

      log("INFO", "Assignment submission event received", { event_id: event?.event_id || null });
      const validationError = validateEvent(event);
      if (validationError) {
        await recordFailedEvent(firestore, event, validationError, "rejected", 0, message.id);
        message.ack();
        return;
      }

      await firestore.collection("submission_requests").doc(event.event_id).set({
        status: "processing",
        notification_title: "Processing your assignment",
        notification_message: "Your PDF passed initial checks and is being processed.",
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true });

      let attempts = 0;
      let result;
      try {
        result = await retryOperation(async () => {
          attempts++;
          if (event.data?.simulate_permanent_failure === true) throw new Error("Simulated permanent processing failure");
          if (event.data?.simulate_temporary_failure === true && attempts <= 2) {
            throw new Error(`Simulated temporary processing failure ${attempts}`);
          }
          return processIdempotentEvent(firestore, event);
        }, event.event_id, maxAttempts);
      } catch (error) {
        await recordFailedEvent(firestore, event, error.message, "failed", attempts, message.id);
        message.ack();
        return;
      }

      if (result.status === "duplicate") {
        log("WARNING", "Student attempted to submit an assignment more than once", {
          event_id: event.event_id,
          student_id: event.student_id,
          activity_id: event.activity_id,
          original_event_id: result.original_event_id
        });
      } else if (result.status === "redelivery") {
        log("INFO", "Pub/Sub redelivery ignored by event ID idempotency", { event_id: event.event_id });
      } else {
        log("INFO", "Assignment submission processed successfully", { event_id: event.event_id, attempts });
      }
      message.ack();
    } catch (error) {
      log("ERROR", "Consumer could not complete processing", {
        event_id: event?.event_id || null,
        error: error.message
      });
      message.nack();
    }
  };
}

module.exports = { createConsumer };
