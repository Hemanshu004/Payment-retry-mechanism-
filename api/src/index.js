/**
 * API Entry Point
 *
 * Express server that accepts payment requests.
 * NEVER processes payments directly — only publishes to RabbitMQ.
 *
 * Routes:
 *   GET  /health   — health check
 *   GET  /payments — list payments
 *   POST /payments — create a payment
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const { initPool, closePool } = require('./db');
const { initQueue, closeQueue } = require('./queue');
const healthRoutes = require('./routes/health');
const paymentRoutes = require('./routes/payments');

const app = express();
const PORT = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/health', healthRoutes);
app.use('/payments', paymentRoutes);
app.use(express.static(path.join(__dirname, 'public')));

async function main() {
  // --- Initialize infrastructure ---
  await initPool();
  await initQueue();

  // --- Start listening ---
  const port = process.env.API_PORT || 3000;
  const server = app.listen(port, () => {
    console.log(JSON.stringify({
      level: 'info', time: new Date().toISOString(),
      service: 'payment-api', msg: `API service started on port ${port}`,
    }));
    console.log(`Dashboard available at http://localhost:${port}`);
  });

  // --- Graceful shutdown ---
  async function shutdown(signal) {
    console.log(JSON.stringify({
      level: 'info', time: new Date().toISOString(),
      service: 'payment-api', msg: `Received ${signal}, shutting down`,
    }));

    server.close(async () => {
      await closeQueue();
      await closePool();
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start API service:', err);
  process.exit(1);
});
