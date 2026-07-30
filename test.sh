#!/usr/bin/env bash
# =============================================================================
# Smoke Test Script for Payment Retry Mechanism (BullMQ Version)
# =============================================================================

set -euo pipefail

API="http://localhost:3000"
PASS=0
FAIL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "$desc"
    PASS=$((PASS + 1))
  else
    red "$desc (expected=$expected, got=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

get_status() {
  local id="$1"
  curl -s "$API/payments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('payments', []):
    if p['id'] == '$id':
        print(p['status'])
        sys.exit(0)
print('UNKNOWN')
" 2>/dev/null || echo "UNKNOWN"
}

get_retry_count() {
  local id="$1"
  curl -s "$API/payments" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('payments', []):
    if p['id'] == '$id':
        print(p['retry_count'])
        sys.exit(0)
print('-1')
" 2>/dev/null || echo "-1"
}

echo ""
echo "══════════════════════════════════════════════════"
echo "  Payment System — BullMQ Smoke Tests"
echo "══════════════════════════════════════════════════"
echo ""

echo "Waiting for API to be ready..."
for i in $(seq 1 30); do
  if curl -sf "$API/health" > /dev/null 2>&1; then
    echo "API is up!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    red "API did not become ready within 30 seconds"
    exit 1
  fi
  sleep 1
done
echo ""

# ─── Test 1: Health check ─────────────────────────────────────────────────────
echo "--- Test 1: Health check ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/health")
check "GET /health returns 200" "200" "$HTTP_CODE"

# ─── Test 2: Create a payment (SUCCESS) ───────────────────────────────────────
echo ""
echo "--- Test 2: Create a payment (amount 101 -> SUCCESS) ---"
KEY_SUCC="succ-$(date +%s)-$RANDOM"
RESP=$(curl -s -X POST "$API/payments" -H "Content-Type: application/json" -H "Idempotency-Key: $KEY_SUCC" -d '{"amount": 101, "currency": "USD"}')
ID_SUCC=$(echo "$RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

sleep 2
STATUS=$(get_status "$ID_SUCC")
check "Payment processes successfully" "SUCCESS" "$STATUS"

# ─── Test 3: Idempotency ──────────────────────────────────────────────────────
echo ""
echo "--- Test 3: Idempotency (same key → 200) ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/payments" -H "Content-Type: application/json" -H "Idempotency-Key: $KEY_SUCC" -d '{"amount": 101, "currency": "USD"}')
check "POST /payments with same key returns 200" "200" "$HTTP_CODE"

# ─── Test 4: Permanent Failure ────────────────────────────────────────────────
echo ""
echo "--- Test 4: Permanent Failure (amount 103 -> FATAL_ERROR) ---"
KEY_FATAL="fatal-$(date +%s)-$RANDOM"
RESP=$(curl -s -X POST "$API/payments" -H "Content-Type: application/json" -H "Idempotency-Key: $KEY_FATAL" -d '{"amount": 103, "currency": "USD"}')
ID_FATAL=$(echo "$RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

sleep 2
STATUS=$(get_status "$ID_FATAL")
check "Payment fails immediately without retries" "FAILED" "$STATUS"

# ─── Test 5: Temporary Failure & Exhausted Retries ────────────────────────────
echo ""
echo "--- Test 5: Temporary Failure (amount 102 -> RETRYABLE_ERROR) ---"
KEY_TEMP="temp-$(date +%s)-$RANDOM"
RESP=$(curl -s -X POST "$API/payments" -H "Content-Type: application/json" -H "Idempotency-Key: $KEY_TEMP" -d '{"amount": 102, "currency": "USD"}')
ID_TEMP=$(echo "$RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

# Should be in RETRY_SCHEDULED quickly
sleep 2
STATUS=$(get_status "$ID_TEMP")
check "Payment enters RETRY_SCHEDULED state" "RETRY_SCHEDULED" "$STATUS"

# Wait for 5 attempts to exhaust. Base is 2s exponential (2, 4, 8, 16s = ~30s max wait)
echo "  Waiting ~32s for 4 retries to exhaust natively via BullMQ..."
sleep 32

STATUS=$(get_status "$ID_TEMP")
check "Payment exhausted attempts and is DEAD_LETTERED" "DEAD_LETTERED" "$STATUS"
RETRY_COUNT=$(get_retry_count "$ID_TEMP")
check "Retry count reached 5 (1 initial + 4 retries = 5 attempts)" "5" "$RETRY_COUNT"

# ─── Test 6: Reconciliation Recovery ──────────────────────────────────────────
echo ""
echo "--- Test 6: Reconciliation Recovery ---"
# Insert a raw DB record simulating a failure between commit and Redis enqueue
KEY_RECON="recon-$(date +%s)-$RANDOM"
# Use local psql if docker is not available
if command -v docker >/dev/null 2>&1; then
  RAW_INSERT=$(docker exec payment-postgres psql -U payments -d payments -t -c "
    INSERT INTO payments (idempotency_key, amount, currency, status, created_at)
    VALUES ('$KEY_RECON', 101, 'USD', 'CREATED', NOW() - INTERVAL '2 minutes')
    RETURNING id;
  ")
else
  RAW_INSERT=$(psql -h localhost -p 5433 -d payments -t -c "
    INSERT INTO payments (idempotency_key, amount, currency, status, created_at)
    VALUES ('$KEY_RECON', 101, 'USD', 'CREATED', NOW() - INTERVAL '2 minutes')
    RETURNING id;
  ")
fi
ID_RECON=$(echo "$RAW_INSERT" | tr -d '[:space:]')
echo "  Manually inserted CREATED payment: $ID_RECON (backdated 2 mins)"

echo "  Waiting ~62s for the reconciliation scanner (runs every 60s)..."
sleep 62

STATUS=$(get_status "$ID_RECON")
check "Reconciliation scanner picked up and processed the payment" "SUCCESS" "$STATUS"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
