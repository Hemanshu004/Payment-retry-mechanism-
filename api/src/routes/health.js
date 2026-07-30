/**
 * Health Route — GET /health
 *
 * Simple endpoint for Docker health checks and load balancer probes.
 */

const { Router } = require('express');

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'payment-api',
  });
});

module.exports = router;
