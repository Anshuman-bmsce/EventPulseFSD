function log(severity, message, fields = {}) {
    console.log(JSON.stringify({
        severity,
        message,
        service: "eventpulse-consumer",
        timestamp: new Date().toISOString(),
        ...fields
    }));
}

module.exports = { log };