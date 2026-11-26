const { log } = require("./logger");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation(operation, eventId, maxAttempts = 3) {

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {
            return await operation();

        } catch (error) {

            log("ERROR", "Event processing attempt failed", {
                event_id: eventId,
                attempt,
                error: error.message
            });

            if (attempt === maxAttempts) {
                throw error;
            }

            const delay = 500 * (2 ** (attempt - 1));

            log("WARNING", "Retry scheduled", {
                event_id: eventId,
                next_attempt: attempt + 1,
                delay_ms: delay
            });

            await sleep(delay);
        }
    }
}

module.exports = { retryOperation };