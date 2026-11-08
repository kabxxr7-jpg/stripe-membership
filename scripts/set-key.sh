#!/bin/zsh
# Prompts for a Stripe TEST secret key (input hidden) and writes it into .env. Refuses live keys.
cd "$(dirname "$0")/.."
read -rs "key?Paste the sandbox's sk_test_ secret key and press Enter: "; echo
[[ "$key" == sk_test_* ]] || { echo "Not a test key (must start with sk_test_). Nothing changed."; exit 1; }
grep -v '^STRIPE_SECRET_KEY=' .env > .env.tmp; print -r -- "STRIPE_SECRET_KEY=$key" >> .env.tmp; mv .env.tmp .env; chmod 600 .env
echo "Saved to .env."
