#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $API_PID $VITE_PID 2>/dev/null
  wait $API_PID $VITE_PID 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

echo "Starting API server on :3001..."
npx tsx watch src/index.ts &
API_PID=$!

echo "Starting dashboard on :5173..."
cd dashboard
npx vite &
VITE_PID=$!
cd ..

echo ""
echo "Dashboard: http://localhost:5173"
echo "API:       http://localhost:3001/api/health"
echo "Press Ctrl+C to stop both."
echo ""

wait
