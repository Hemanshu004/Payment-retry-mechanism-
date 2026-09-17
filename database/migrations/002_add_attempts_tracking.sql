-- ============================================================================
-- STEP 2: ADD ATTEMPT TRACKING
-- ============================================================================
-- Adds provider_transaction_id to payments table and creates
-- payment_attempts table to log each processing attempt.
-- ============================================================================

-- Add provider_transaction_id to payments (stored after successful gateway call)
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT NULL;

COMMENT ON COLUMN payments.provider_transaction_id IS 'Transaction ID returned by the payment gateway on SUCCESS. NULL until gateway confirms.';

-- ============================================================================
-- PAYMENT ATTEMPTS TABLE
-- ============================================================================
-- Logs every processing attempt for observability.
-- Each row represents one worker attempt at processing a payment.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_attempts (
    id SERIAL PRIMARY KEY,

    -- FK to payments table
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,

    -- Which attempt this was (1-indexed)
    attempt_number INTEGER NOT NULL,

    -- Result of this attempt: 'SUCCESS', 'RETRYABLE_ERROR', 'FATAL_ERROR'
    status TEXT NOT NULL,

    -- Raw gateway response message
    gateway_response TEXT NULL,

    -- Error message if the attempt failed
    error_message TEXT NULL,

    -- When this attempt was executed
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    -- Prevent duplicate attempt records
    CONSTRAINT unique_payment_attempt UNIQUE (payment_id, attempt_number)
);

-- Index for looking up attempts by payment
CREATE INDEX IF NOT EXISTS idx_payment_attempts_payment_id
    ON payment_attempts (payment_id, attempt_number);

COMMENT ON TABLE payment_attempts IS 'Audit log of each payment processing attempt. Used for observability and attempt timeline display.';
