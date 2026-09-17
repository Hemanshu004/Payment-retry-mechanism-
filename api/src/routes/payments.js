/**
 * Payments Routes — POST /payments, GET /payments
 *
 * POST /payments
 *   - Validates body (amount, currency) and Idempotency-Key header
 *   - Inserts a new payment with status CREATED
 *   - If the idempotency key already exists (UNIQUE violation), returns the existing payment
 *   - Publishes a job to RabbitMQ AFTER the database commit
 *   - Returns 201 (new) or 200 (existing)
 *
 * GET /payments
 *   - Lists the most recent 100 payments (for the dashboard)
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { getClient, query } = require('../db');
const { addPaymentJob } = require('../queue');

const router = Router();

// PostgreSQL error code for UNIQUE constraint violation
const PG_UNIQUE_VIOLATION = '23505';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map a database row to a plain payment object.
 */
function mapRow(row) {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    next_retry_at: row.next_retry_at,
    failure_reason: row.failure_reason,
    provider_transaction_id: row.provider_transaction_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── GET /payments ────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const result = await query(
      'SELECT * FROM payments ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ payments: result.rows.map(mapRow) });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', time: new Date().toISOString(),
      service: 'payment-api', msg: 'Failed to list payments', error: err.message,
    }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /payments/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const paymentResult = await query(
      'SELECT * FROM payments WHERE id = $1',
      [req.params.id]
    );

    if (!paymentResult.rows[0]) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const attemptsResult = await query(
      'SELECT attempt_number, status, gateway_response, error_message, created_at FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_number ASC',
      [req.params.id]
    );

    res.json({
      payment: mapRow(paymentResult.rows[0]),
      attempts: attemptsResult.rows,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', time: new Date().toISOString(),
      service: 'payment-api', msg: 'Failed to get payment details', error: err.message,
    }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /payments ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  // --- Validate Idempotency-Key header ---
  const idempotencyKey = (req.headers['idempotency-key'] || '').trim();
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  // --- Validate body ---
  const { amount, currency } = req.body || {};

  if (amount === undefined || amount === null || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
    return res.status(400).json({ error: 'amount must be a positive integer (smallest currency unit)' });
  }

  if (!currency || typeof currency !== 'string' || currency.trim().length !== 3) {
    return res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code' });
  }

  const normalizedCurrency = currency.trim().toUpperCase();
  const paymentId = uuidv4();

  // --- Insert into database ---
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const insertResult = await client.query(
      `INSERT INTO payments (id, idempotency_key, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'CREATED')
       RETURNING *`,
      [paymentId, idempotencyKey, amount, normalizedCurrency]
    );

    await client.query('COMMIT');

    const payment = mapRow(insertResult.rows[0]);

    // CRITICAL: enqueue AFTER commit so we never have a phantom queue job
    try {
      await addPaymentJob(payment.id);
    } catch (queueErr) {
      console.error(JSON.stringify({
        level: 'error', time: new Date().toISOString(),
        service: 'payment-api', msg: 'Failed to enqueue payment job',
        payment_id: payment.id, error: queueErr.message,
      }));
      // The reconciliation scanner will pick this up later.
    }

    return res.status(201).json({ payment, created: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // Handle UNIQUE violation — return the existing payment
    if (err.code === PG_UNIQUE_VIOLATION) {
      const existing = await query(
        'SELECT * FROM payments WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (!existing.rows[0]) {
        return res.status(500).json({ error: 'Unique violation but payment not found' });
      }
      return res.status(200).json({ payment: mapRow(existing.rows[0]), created: false });
    }

    console.error(JSON.stringify({
      level: 'error', time: new Date().toISOString(),
      service: 'payment-api', msg: 'Failed to create payment', error: err.message,
    }));
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
