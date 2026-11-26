const { FieldValue } = require("@google-cloud/firestore");

function submissionDocumentId(studentId, activityId) {
  return `${studentId}__${activityId}`;
}

async function processIdempotentEvent(firestore, event) {
  const processedRef = firestore.collection("processed_events").doc(event.event_id);
  const submissionRef = firestore.collection("student_submissions")
    .doc(submissionDocumentId(event.student_id, event.activity_id));
  const activityRef = firestore.collection("student_activities")
    .doc(submissionDocumentId(event.student_id, event.activity_id));
  const duplicateRef = firestore.collection("duplicate_events").doc(event.event_id);
  const requestRef = firestore.collection("submission_requests").doc(event.event_id);

  return firestore.runTransaction(async tx => {
    const processedSnapshot = await tx.get(processedRef);
    if (processedSnapshot.exists) {
      return { status: "redelivery", event_id: event.event_id };
    }

    const submissionSnapshot = await tx.get(submissionRef);
    if (submissionSnapshot.exists && submissionSnapshot.data().status === "submitted") {
      const duplicateMessage = "This assignment has already been submitted. Your new attempt was recorded as a duplicate; the original submission remains unchanged.";
      tx.create(processedRef, {
        event_id: event.event_id,
        event_type: event.event_type,
        student_id: event.student_id,
        activity_id: event.activity_id,
        status: "duplicate",
        processed_at: FieldValue.serverTimestamp()
      });
      tx.create(duplicateRef, {
        event_id: event.event_id,
        student_id: event.student_id,
        activity_id: event.activity_id,
        original_event_id: submissionSnapshot.data().event_id,
        file_name: event.data.file_name,
        object_name: event.data.object_name,
        status: "duplicate",
        reason: "A successful submission already exists for this student and assignment",
        detected_at: FieldValue.serverTimestamp()
      });
      tx.set(requestRef, {
        status: "duplicate",
        notification_title: "Duplicate submission detected",
        notification_message: duplicateMessage,
        original_event_id: submissionSnapshot.data().event_id,
        updated_at: FieldValue.serverTimestamp()
      }, { merge: true });
      return { status: "duplicate", event_id: event.event_id, original_event_id: submissionSnapshot.data().event_id };
    }

    const submissionData = {
      event_id: event.event_id,
      student_id: event.student_id,
      student_name: event.data.student_name || event.student_id,
      activity_id: event.activity_id,
      assignment_title: event.data.assignment_title || event.activity_id,
      file_name: event.data.file_name,
      file_size: event.data.file_size,
      content_type: "application/pdf",
      object_name: event.data.object_name,
      status: "submitted",
      submitted_at: FieldValue.serverTimestamp()
    };

    tx.set(submissionRef, submissionData);
    tx.set(activityRef, {
      student_id: event.student_id,
      student_name: event.data.student_name || event.student_id,
      activity_id: event.activity_id,
      assignment_title: event.data.assignment_title || event.activity_id,
      status: "submitted",
      last_event_id: event.event_id,
      event_type: event.event_type,
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(processedRef, {
      event_id: event.event_id,
      event_type: event.event_type,
      student_id: event.student_id,
      activity_id: event.activity_id,
      status: "processed",
      file_name: event.data.file_name,
      processed_at: FieldValue.serverTimestamp()
    });
    tx.set(requestRef, {
      status: "processed",
      notification_title: "Assignment submitted successfully",
      notification_message: "Your PDF was received, validated and recorded successfully.",
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });

    return { status: "processed", event_id: event.event_id };
  });
}

module.exports = { processIdempotentEvent, submissionDocumentId };
