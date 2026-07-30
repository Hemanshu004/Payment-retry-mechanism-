/**
 * Simple JSON Console Logger
 *
 * Replaces Pino. Each line is a JSON object printed to stdout/stderr.
 * Format: { level, time, service, msg, ...extra }
 */

const SERVICE = 'payment-worker';

function _format(level, msg, data) {
  const entry = {
    level,
    time: new Date().toISOString(),
    service: SERVICE,
    msg,
    ...data,
  };
  return JSON.stringify(entry);
}

const log = {
  info(msg, data) {
    console.log(_format('info', msg, data));
  },
  warn(msg, data) {
    console.warn(_format('warn', msg, data));
  },
  error(msg, data) {
    console.error(_format('error', msg, data));
  },
  fatal(msg, data) {
    console.error(_format('fatal', msg, data));
  },
};

/**
 * Create a child-like logger that includes payment_id in every message.
 */
function createPaymentLogger(paymentId) {
  return {
    info(msg, extra)  { log.info(msg, { payment_id: paymentId, ...extra }); },
    warn(msg, extra)  { log.warn(msg, { payment_id: paymentId, ...extra }); },
    error(msg, extra) { log.error(msg, { payment_id: paymentId, ...extra }); },
  };
}

module.exports = { log, createPaymentLogger };
