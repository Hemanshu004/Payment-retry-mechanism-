# Distributed Payment Processing System

A production-grade, interview-defensible payment processing system built with TypeScript, NestJS, PostgreSQL, and RabbitMQ.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PAYMENT PROCESSING SYSTEM                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Client                                                                     │
│     │                                                                        │
│     │ POST /payments                                                         │
│     │ Idempotency-Key: abc123                                               │
│     ▼                                                                        │
│   ┌───────────────────────────────────────────────────────────────┐         │
│   │                    API SERVICE (NestJS)                        │         │
│   │  • Validates request & idempotency key                        │         │
│   │  • Creates payment record in PostgreSQL                       │         │
│   │  • Publishes job to RabbitMQ AFTER commit                     │         │
│   │  • NEVER calls payment gateway                                │         │
│   └─────────────────────────┬─────────────────────────────────────┘         │
│                             │                                                │
│              ┌──────────────┼──────────────┐                                │
│              ▼              ▼              │                                │
│   ┌──────────────┐   ┌─────────────┐      │                                │
│   │  PostgreSQL  │   │  RabbitMQ   │      │                                │
│   │   (SOURCE    │   │   (Job      │      │                                │
│   │   OF TRUTH)  │   │   Queue)    │      │                                │
│   └──────────────┘   └──────┬──────┘      │                                │
│              ▲              │              │                                │
│              │              ▼              │                                │
│   ┌──────────┴────────────────────────────┴──────────────────────┐         │
│   │                   WORKER SERVICE                              │         │
│   │  • Consumes messages from RabbitMQ                           │         │
│   │  • Locks payment with SELECT FOR UPDATE                      │         │
│   │  • Calls mock payment gateway                                │         │
│   │  • Updates state with retry logic                            │         │
│   │  • ACKs message AFTER DB commit                              │         │
│   └───────────────────────────────────────────────────────────────┘         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Payment State Machine

```
                                    ┌─────────────────┐
                                    │                 │
                                    ▼                 │
┌─────────┐    ┌────────────┐    ┌─────────┐    ┌────┴────────────┐
│ CREATED │───▶│ PROCESSING │───▶│ SUCCESS │    │ RETRY_SCHEDULED │
└─────────┘    └────────────┘    └─────────┘    └─────────────────┘
                     │                                   │
                     │           ┌────────┐              │
                     └──────────▶│ FAILED │              │
                     │           └────────┘              │
                     │                                   │
                     │      ┌───────────────┐           │
                     └─────▶│ DEAD_LETTERED │◀──────────┘
                            └───────────────┘     (after max retries)

Terminal States: SUCCESS, FAILED, DEAD_LETTERED
```

## Quick Start

```bash
# Start the entire system
docker compose up --build

# Test creating a payment
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-123" \
  -d '{"amount": 1000, "currency": "USD"}'

# Test idempotency (same key returns same payment)
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-123" \
  -d '{"amount": 1000, "currency": "USD"}'
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| API | NestJS + TypeScript | HTTP interface, validation, idempotency |
| Worker | Node.js + TypeScript | Payment processing, retries |
| Database | PostgreSQL 15 | **Source of truth**, state machine |
| Queue | RabbitMQ 3 | Async job delivery (at-least-once) |
| Cache | Redis 7 | Distributed locks (optional) |
| Logging | Pino | Structured JSON logs |

## Key Design Decisions

### 1. PostgreSQL is the ONLY Source of Truth

- All payment state lives in PostgreSQL
- RabbitMQ messages can be duplicated or lost
- Workers are idempotent and check DB state before processing

### 2. Idempotency via UNIQUE Constraint

```sql
UNIQUE (idempotency_key)
```

If two identical requests arrive simultaneously:
1. Request A: INSERT succeeds
2. Request B: UNIQUE violation → SELECT existing → return same payment

**Result:** Customer is never double-charged.

### 3. Publish AFTER Commit

```typescript
await client.query('COMMIT');  // State persisted
await rabbitmq.publishPaymentJob(paymentId);  // Then publish
```

Why? If we publish before commit and the commit fails, we'd have a phantom job in the queue.

### 4. SELECT FOR UPDATE Prevents Concurrent Processing

```sql
SELECT * FROM payments WHERE id = $1 FOR UPDATE NOWAIT
```

If two workers try to process the same payment:
1. Worker A: Acquires lock
2. Worker B: NOWAIT throws error → re-queues message
3. Worker A: Completes processing

### 5. Manual ACK After Commit

```typescript
await client.query('COMMIT');  // State persisted
channel.ack(msg);  // Then ACK
```

If worker crashes after processing but before ACK, the message is redelivered. The worker checks state and skips already-processed payments.

## Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| API crashes after INSERT, before publish | Payment in CREATED, retry scanner picks it up |
| Worker crashes during PROCESSING | Message redelivered, worker re-locks and continues |
| Worker crashes after gateway call, before commit | Message redelivered, worker detects PROCESSING state |
| Database temporarily unavailable | Both services retry with exponential backoff |
| RabbitMQ unavailable | API returns 500, payment stays in CREATED |
| Duplicate message from RabbitMQ | Worker checks state, skips if not CREATED/RETRY_SCHEDULED |

## Retry Algorithm

Exponential backoff with jitter:

```
next_retry_at = NOW() + base_delay * (2 ^ retry_count)
```

| Retry | Delay |
|-------|-------|
| 1 | 2 seconds |
| 2 | 4 seconds |
| 3 | 8 seconds |
| 4 | 16 seconds |
| 5 | Dead-lettered |

## Environment Variables

```bash
# PostgreSQL
POSTGRES_USER=payments
POSTGRES_PASSWORD=payments_secret_2024
POSTGRES_DB=payments
DATABASE_URL=postgresql://payments:payments_secret_2024@postgres:5432/payments

# RabbitMQ
RABBITMQ_DEFAULT_USER=payments
RABBITMQ_DEFAULT_PASS=rabbitmq_secret_2024
RABBITMQ_URL=amqp://payments:rabbitmq_secret_2024@rabbitmq:5672

# Redis
REDIS_URL=redis://redis:6379

# API
API_PORT=3000

# Worker
WORKER_CONCURRENCY=1
GATEWAY_SUCCESS_RATE=70
GATEWAY_RETRYABLE_RATE=20
```

## API Reference

### POST /payments

Create a new payment.

**Headers:**
- `Content-Type: application/json`
- `Idempotency-Key: <unique-string>` (required)

**Request:**
```json
{
  "amount": 1000,
  "currency": "USD"
}
```

**Response (201 Created):**
```json
{
  "payment": {
    "id": "uuid",
    "idempotency_key": "unique-key",
    "amount": 1000,
    "currency": "USD",
    "status": "CREATED",
    "retry_count": 0,
    "max_retries": 5,
    "next_retry_at": null,
    "failure_reason": null,
    "created_at": "2024-01-15T10:00:00Z",
    "updated_at": "2024-01-15T10:00:00Z"
  },
  "created": true
}
```

**Response (200 OK - Idempotent):**
```json
{
  "payment": { /* existing payment */ },
  "created": false
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:00:00Z"
}
```

## Monitoring

### RabbitMQ Management UI
- URL: http://localhost:15672
- Credentials: See RABBITMQ_DEFAULT_USER/PASS in .env

### Logs

```bash
# View API logs
docker logs -f payment-api

# View Worker logs (JSON structured)
docker logs -f payment-worker

# View specific payment processing
docker logs payment-worker 2>&1 | grep "payment-id-here"
```

## Project Structure

```
payment-system/
├── api/                      # NestJS API service
│   ├── src/
│   │   ├── database/         # PostgreSQL connection
│   │   ├── rabbitmq/         # Queue producer
│   │   ├── payments/         # Payment controller & service
│   │   └── health/           # Health check
│   ├── Dockerfile
│   └── package.json
├── worker/                   # Payment processor
│   ├── src/
│   │   ├── index.ts          # Entry point
│   │   ├── consumer.ts       # Queue consumer
│   │   ├── processor.ts      # Payment processing logic
│   │   ├── gateway.ts        # Mock payment gateway
│   │   ├── database.ts       # PostgreSQL client
│   │   └── logger.ts         # Pino structured logging
│   ├── Dockerfile
│   └── package.json
├── database/
│   └── migrations/           # SQL schema
├── docker-compose.yml
├── .env
└── README.md
```

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| PostgreSQL as source of truth | Slightly slower than Redis, but guarantees durability |
| At-least-once delivery | Consumers must be idempotent, but no message loss |
| SELECT FOR UPDATE | Blocks concurrent access, but prevents double-processing |
| Exponential backoff | Longer wait times for retries, but prevents thundering herd |
| Separate API/Worker | More complexity, but allows independent scaling |

## Interview Talking Points

1. **Why not use ON CONFLICT DO UPDATE?**
   - For payments, we never want to modify on duplicate
   - Explicit INSERT + SELECT is clearer for auditing

2. **Why publish after commit?**
   - Prevents phantom jobs if transaction rolls back
   - If publish fails, retry scanner picks up orphaned payments

3. **Why SELECT FOR UPDATE NOWAIT?**
   - Prevents deadlocks
   - Failing fast allows message to be requeued

4. **Why not use Redis as source of truth?**
   - Redis can lose data on crashes (even with AOF)
   - PostgreSQL provides ACID guarantees required for payments

5. **How do you handle exactly-once semantics?**
   - We don't. RabbitMQ provides at-least-once.
   - Idempotency at the application layer ensures same result.

## License

MIT
