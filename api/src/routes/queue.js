/**
 * Queue Routes — GET /queue/stats
 *
 * Exposes BullMQ job counts for dashboard observability.
 * All values come directly from BullMQ's getJobCounts() — nothing is hardcoded.
 */

const { Router } = require('express');
const { getQueue } = require('../queue');
const { query } = require('../db');

const router = Router();

router.get('/stats', async (_req, res) => {
  try {
    const queue = getQueue();
    if (!queue) {
      return res.status(503).json({ error: 'Queue not initialized' });
    }

    const counts = await queue.getJobCounts(
      'waiting', 'active', 'delayed', 'failed'
    );

    // BullMQ automatically removes completed jobs (removeOnComplete: true),
    // so its 'completed' count is always 0. Instead, we return the total
    // count of successful payments from PostgreSQL.
    const dbResult = await query("SELECT COUNT(*) FROM payments WHERE status = 'SUCCESS'");
    const completedPayments = parseInt(dbResult.rows[0].count, 10);

    res.json({
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      delayed: counts.delayed || 0,
      failed: counts.failed || 0,
      completed_payments: completedPayments,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', time: new Date().toISOString(),
      service: 'payment-api', msg: 'Failed to get queue stats', error: err.message,
    }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
