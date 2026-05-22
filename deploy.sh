#!/bin/bash
# CraftHost deploy script
# Usage: ./deploy.sh [local|railway]

set -e
cd "$(dirname "$0")"

MODE="${1:-local}"

if [ "$MODE" = "local" ]; then
  echo "→ Deploying to local web root /home/khaled/www/crafthost/"
  rm -rf /home/khaled/www/crafthost
  mkdir -p /home/khaled/www/crafthost
  cp -r frontend/* /home/khaled/www/crafthost/
  echo "✓ Static frontend deployed to http://localhost/crafthost/"
  echo
  echo "To run backend:"
  echo "  cd /home/khaled/crafthost"
  echo "  npm install"
  echo "  npm run init-db"
  echo "  npm start    # http://localhost:4000"
elif [ "$MODE" = "railway" ]; then
  echo "→ Deploying to Railway..."
  command -v railway >/dev/null || { echo "Install railway CLI first: npm i -g @railway/cli"; exit 1; }
  railway up
else
  echo "Unknown mode: $MODE (use 'local' or 'railway')"
  exit 1
fi
