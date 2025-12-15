#!/bin/bash
#
# Run all tests for Inky Soup.
# Starts the server, runs unit and e2e tests, then cleans up.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output.
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Inky Soup Test Suite${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo

# Track overall success.
LINT_RESULT=0
UNIT_RESULT=0
E2E_RESULT=0

# Run linter first.
echo -e "${YELLOW}▶ Running ESLint...${NC}"
if npm run lint; then
    echo -e "${GREEN}✓ Linting passed${NC}"
else
    echo -e "${RED}✗ Linting failed${NC}"
    LINT_RESULT=1
fi
echo

# Run unit tests (no server needed).
echo -e "${YELLOW}▶ Running unit tests...${NC}"
if npm test; then
    echo -e "${GREEN}✓ Unit tests passed${NC}"
else
    echo -e "${RED}✗ Unit tests failed${NC}"
    UNIT_RESULT=1
fi
echo

# Start the server in the background.
echo -e "${YELLOW}▶ Starting server...${NC}"
cargo run --release 2>&1 &
SERVER_PID=$!

# Wait for server to be ready.
echo -n "  Waiting for server"
for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:8000/; then
        echo -e " ${GREEN}ready${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

# Check if server started.
if ! curl -s -o /dev/null http://localhost:8000/; then
    echo -e " ${RED}failed to start${NC}"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi
echo

# Run e2e tests.
echo -e "${YELLOW}▶ Running e2e tests...${NC}"
if npm run test:e2e; then
    echo -e "${GREEN}✓ E2E tests passed${NC}"
else
    echo -e "${RED}✗ E2E tests failed${NC}"
    E2E_RESULT=1
fi
echo

# Stop the server.
echo -e "${YELLOW}▶ Stopping server...${NC}"
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
echo -e "  Server stopped"
echo

# Clean up test artifacts.
echo -e "${YELLOW}▶ Cleaning up test artifacts...${NC}"
rm -f static/images/*.png static/images/*.jpg 2>/dev/null || true
rm -f static/images/cache/* static/images/thumbs/* static/images/dithered/* 2>/dev/null || true
rm -f static/images/metadata.json 2>/dev/null || true
echo -e "  Cleaned up"
echo

# Summary.
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
if [ $LINT_RESULT -eq 0 ] && [ $UNIT_RESULT -eq 0 ] && [ $E2E_RESULT -eq 0 ]; then
    echo -e "${GREEN}  All tests passed! ✓${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
    exit 0
else
    echo -e "${RED}  Some tests failed ✗${NC}"
    [ $LINT_RESULT -ne 0 ] && echo -e "${RED}    - Linting${NC}"
    [ $UNIT_RESULT -ne 0 ] && echo -e "${RED}    - Unit tests${NC}"
    [ $E2E_RESULT -ne 0 ] && echo -e "${RED}    - E2E tests${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
    exit 1
fi
