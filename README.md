# Payment Retry Mechanism

A distributed payment processing backend that mimics how a real production system handles payments, failures, and retries. 

I wanted to build a payment backend that behaves more like a real production system instead of a simple CRUD application. The main focus was reliability, idempotency, retries, and recovery from failures. Instead of blindly trusting network requests, this system uses a database-first approach and delegates asynchronous retry scheduling to a background job queue.

## Features

- **Idempotent payment creation**: Ensures users are never double-charged by safely ignoring duplicate requests.
- **PostgreSQL as source of truth**: All state transitions and locks are strictly managed in the database, meaning no data is lost if the queue or workers crash.
- **Background job processing**: Uses BullMQ (backed by Redis) to decouple the fast API layer from the slow payment gateway.
- **Automatic retries**: Temporary network errors trigger automatic retries without blocking the main API.
- **Exponential backoff**: Retry delays increase exponentially to prevent overwhelming the payment gateway during an outage.
- **Dead letter handling**: Payments that exhaust all retry attempts are safely marked as dead-lettered for manual review.
- **Recovery scanner**: A background reconciliation process picks up any payments that were saved to the database but failed to reach the queue.
- **Docker support**: Fully containerized setup for easy local development.

## Architecture

```mermaid
flowchart TD
    Client["Client / Dashboard"]
    API["Express API"]
    DB[("PostgreSQL\n(Source of Truth)")]
    Queue["BullMQ + Redis\n(Job Scheduling & Retries)"]
    Worker["Worker\n(Separate Process)"]
    Gateway["Simulated Payment Gateway"]

    Client -->|Idempotency-Key| API
    API -->|Persists Payment| DB
    API -->|Enqueues Job| Queue
    
    %% Recovery Path
    DB -.->|Reconciliation (Recovers stuck payments)| Queue
    
    Queue -->|Pulls Job| Worker
    Worker <-->|Locks Row & Updates State| DB
    Worker -->|Processes Payment| Gateway
    
    %% Retry Path
    Gateway -.->|Temporary Failure| Worker
    Worker -.->|Schedules Retry| Queue
```
- **Client**: Initiates the payment request with a unique idempotency key.
- **Express API**: Receives the request, validates it, and inserts it into PostgreSQL. It intentionally avoids calling the payment gateway directly to ensure low latency and high availability.
- **PostgreSQL**: Acts as the absolute source of truth. It enforces uniqueness to prevent duplicates and provides row-level locks so multiple workers don't process the same payment at the exact same time.
- **BullMQ (Redis)**: Acts strictly as a job scheduler. It holds the queue of pending payments and automatically handles delayed retries if the gateway fails.
- **Worker**: An independent Node.js process that picks up jobs from BullMQ, acquires a database lock, and coordinates the actual payment processing.
- **Gateway**: A mock external payment provider (like Stripe or PayPal) that simulates latency, random failures, and successes.

## Payment Lifecycle

1. **CREATED**: The initial state when a payment is safely stored in PostgreSQL, but hasn't been processed yet.
2. **PROCESSING**: The worker has locked the row and is actively communicating with the payment gateway.
3. **SUCCESS**: The gateway confirmed the payment was successfully processed.
4. **RETRY_SCHEDULED**: The gateway returned a temporary error (like a timeout). The job is delayed and will be tried again soon.
5. **FAILED**: The gateway returned a permanent error (like insufficient funds or an invalid card). No further retries are attempted.
6. **DEAD_LETTERED**: The payment encountered temporary errors repeatedly and exhausted the maximum number of retry attempts.

## Retry Strategy

When the worker encounters a temporary failure from the payment gateway, it updates the database status to `RETRY_SCHEDULED` and delegates the retry logic to BullMQ.

BullMQ uses an exponential backoff strategy (starting at 2 seconds) to delay the next attempt. This is much cleaner than writing a custom retry loop because the worker is immediately freed up to process other payments. If the payment fails 5 times consecutively, it hits the maximum attempt limit and transitions into the `DEAD_LETTERED` state.

## Idempotency

Duplicate payments are dangerous. If a user has a slow internet connection and impatiently clicks the "Pay" button three times, the API will receive three identical requests. 

To solve this, the client generates a unique `Idempotency-Key` and sends it in the request headers. We map this key to a `UNIQUE` constraint in PostgreSQL. When the second and third requests arrive, the database rejects the duplicate inserts. The API catches this constraint violation and simply returns the original payment record instead of trying to charge the user again.

## Recovery Mechanism

Network partitions happen. Sometimes the Express API will successfully commit the `CREATED` payment to PostgreSQL, but crash right before it can enqueue the job into BullMQ (or Redis might be temporarily offline).

To handle this, a reconciliation scanner runs in the background. It periodically looks for payments that have been stuck in the `CREATED` state for too long and safely pushes them into BullMQ. Because PostgreSQL is the source of truth, we never lose a payment request just because the queue was momentarily unavailable.

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Node.js, Express |
| Queue | BullMQ, Redis |
| Database | PostgreSQL 15 |
| ORM/Driver | pg (node-postgres) |
| Containerization | Docker, Docker Compose |
| Language | JavaScript (CommonJS) |

## Project Structure

- `api/`: The Express HTTP server that handles incoming requests.
- `worker/`: The background Node.js process that handles BullMQ jobs and talks to the gateway.
- `database/`: Raw SQL migration files.

## Running Locally

To run the entire stack (PostgreSQL, Redis, API, and Worker):

```bash
cp .env.example .env
docker compose up --build
```

The database migrations will run automatically on boot.

## API

### POST /payments
Creates a new payment.

**Request:**
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-unique-key-123" \
  -d '{"amount": 1000, "currency": "USD"}'
```

### GET /payments
Lists the most recent payments.

**Request:**
```bash
curl http://localhost:3000/payments
```

### GET /health
Returns the health status of the API.

**Request:**
```bash
curl http://localhost:3000/health
```

## Failure Scenarios Covered

- **Duplicate requests**: Handled natively by PostgreSQL unique constraints.
- **Redis unavailable**: API ignores the queue failure and leaves the payment in PostgreSQL; reconciliation handles it later.
- **Gateway temporary failure**: Worker leverages BullMQ exponential backoff for scheduled retries.
- **Gateway permanent failure**: Worker immediately marks the payment as failed without wasting retry attempts.
- **Worker restart**: On boot, the worker resets any stuck `PROCESSING` payments back to `CREATED`.
- **Database-first enqueue pattern**: Prevents phantom jobs by guaranteeing the database commit succeeds before ever touching the queue.

## Future Improvements

- Add Prometheus metrics and OpenTelemetry tracing to monitor queue latency and gateway failure rates.
- Build a simple frontend dashboard to visualize payment states in real-time.
- Implement strict rate limiting on the API to prevent abuse.
- Add authentication (JWT or API Keys) to the endpoints.
- Implement webhook callbacks to notify clients asynchronously when a payment reaches a terminal state.

## Lessons Learned

Building this taught me why a database-first approach is so much safer than queue-first. If you put a job in a queue before saving it to the database, a sudden crash means you have a ghost job processing a payment that doesn't exist in your system. 

I also realized that treating queues as the source of truth is a trap. BullMQ is fantastic for managing concurrency and exponential backoffs, but it's volatile by nature. Keeping the strict state machine in PostgreSQL makes reasoning about the system much simpler. Switching from RabbitMQ to BullMQ significantly reduced the boilerplate needed for dead-lettering and retries, allowing me to focus more on the actual payment lifecycle.
