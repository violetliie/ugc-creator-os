#!/usr/bin/env bash
# Scan staged diff for known secret patterns. Run before committing.
# Patterns covered:
#   eyJ[A-Za-z0-9_-]{20,}   Supabase JWT-style tokens (anon/service role)
#   zpka_[a-f0-9]{32}_[a-f0-9]{8}   Shortimize API key
#   sk_(live|test)_         Stripe-style keys
#   xoxb-, xoxp-            Slack bot tokens
set -e
PATTERN='eyJ[A-Za-z0-9_-]{20,}|zpka_[a-f0-9]{32}|sk_(live|test)_[a-zA-Z0-9]{24,}|xox[bp]-[A-Za-z0-9-]+'
if git diff --cached --no-color | grep -E "$PATTERN" > /dev/null; then
  echo "[check-secrets] ABORT: secret-looking string in staged diff."
  echo "Patterns matched (review before committing):"
  git diff --cached --no-color | grep -nE "$PATTERN"
  exit 1
fi
echo "[check-secrets] OK"
