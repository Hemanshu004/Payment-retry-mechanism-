-- ============================================================================
-- STEP 2: PAYMENTS TABLE SCHEMA
-- ============================================================================
-- This is the SOURCE OF TRUTH for all payment state.
-- Every payment operation MUST go through this table.
-- PostgreSQL row-level locking (SELECT FOR UPDATE) prevents double-processing.
-- ============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- PAYMENTS TABLE
-- ============================================================================
CREATE TABLE payments (
    -- ========================================================================
    -- IDENTITY
    -- ========================================================================
    
    -- Primary key: Unique identifier for each payment record
    -- Using UUID to prevent enumeration attacks and enable distributed ID generation
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Idempotency key: Client-provided unique identifier
    -- CRITICAL: This is the ONLY defense against double-charging
    -- The UNIQUE constraint ensures the same payment cannot be created twice
    -- Client sends this key; if payment already exists, we return existing result
    idempotency_key TEXT NOT NULL UNIQUE,
    
    -- ========================================================================
    -- PAYMENT DETAILS
    -- ========================================================================
    
    -- Amount in smallest currency unit (cents for USD, paise for INR)
    -- Using INTEGER avoids floating-point precision issues
    -- Example: $10.50 USD = 1050 cents
    amount INTEGER NOT NULL,
    
    -- ISO 4217 currency code (e.g., 'USD', 'EUR', 'INR')
    -- Stored with amount to prevent currency confusion
    currency TEXT NOT NULL,
    
    -- ========================================================================
    -- STATE MACHINE
    -- ========================================================================
    
    -- Current status of the payment
    -- This column drives the entire payment lifecycle
    -- CHECK constraint enforces valid transitions at DB level
    status TEXT NOT NULL DEFAULT 'CREATED',
    
    -- ========================================================================
    -- RETRY MECHANISM
    -- ========================================================================
    
    -- Number of times this payment has been retried
    -- Incremented on each failed attempt that will be retried
    retry_count INTEGER NOT NULL DEFAULT 0,
    
    -- Maximum retry attempts before moving to DEAD_LETTERED
    -- Configurable per payment (some payments may need more retries)
    max_retries INTEGER NOT NULL DEFAULT 5,
    
    -- When to attempt the next retry (NULL if not scheduled)
    -- Workers scan for: status = 'RETRY_SCHEDULED' AND next_retry_at <= now()
    next_retry_at TIMESTAMP NULL,
    
    -- ========================================================================
    -- ERROR TRACKING
    -- ========================================================================
    
    -- Human-readable reason for failure (NULL if not failed)
    -- Stored for debugging and customer support
    -- Examples: 'INSUFFICIENT_FUNDS', 'CARD_DECLINED', 'GATEWAY_TIMEOUT'
    failure_reason TEXT NULL,
    
    -- ========================================================================
    -- AUDIT TIMESTAMPS
    -- ========================================================================
    
    -- When the payment record was created
    -- Immutable after creation
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- When the payment record was last modified
    -- Updated on every state change
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- ========================================================================
    -- CONSTRAINTS
    -- ========================================================================
    
    -- Enforce valid status values at DB level
    -- This prevents invalid states even if application has bugs
    CONSTRAINT valid_status CHECK (
        status IN (
            'CREATED',          -- Initial state: payment record created, not yet processed
            'PROCESSING',       -- Worker has picked up the payment, calling gateway
            'SUCCESS',          -- Payment completed successfully (terminal state)
            'FAILED',           -- Payment failed permanently (terminal state)
            'RETRY_SCHEDULED',  -- Transient failure, will retry after next_retry_at
            'DEAD_LETTERED'     -- All retries exhausted (terminal state)
        )
    ),
    
    -- Ensure amount is positive
    CONSTRAINT positive_amount CHECK (amount > 0),
    
    -- Ensure currency is a valid 3-letter code
    CONSTRAINT valid_currency CHECK (LENGTH(currency) = 3)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Index for retry scanner: Find payments ready to be retried
-- Workers query: WHERE status = 'RETRY_SCHEDULED' AND next_retry_at <= NOW()
-- Composite index enables efficient scanning without full table scan
CREATE INDEX idx_payments_retry_scan 
    ON payments (status, next_retry_at) 
    WHERE status = 'RETRY_SCHEDULED';

-- Index for idempotency lookups (implicit from UNIQUE constraint, but explicit for clarity)
-- This index is automatically created by the UNIQUE constraint on idempotency_key

-- ============================================================================
-- TRIGGER: Auto-update updated_at timestamp
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE payments IS 'Source of truth for all payment records. All payment state changes MUST go through this table.';
COMMENT ON COLUMN payments.idempotency_key IS 'Client-provided unique key to prevent duplicate payments. UNIQUE constraint enforces at-most-once processing.';
COMMENT ON COLUMN payments.status IS 'Current state in payment lifecycle. CHECK constraint enforces valid values.';
COMMENT ON COLUMN payments.next_retry_at IS 'Timestamp for next retry attempt. NULL unless status is RETRY_SCHEDULED.';
