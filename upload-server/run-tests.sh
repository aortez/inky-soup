#!/bin/bash
#
# Run all tests for Inky Soup.
# Uses Docker to match production environment.
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
echo -e "${YELLOW}  Inky Soup Test Suite (Docker)${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo

# Track overall success.
LINT_RESULT=0
UNIT_RESULT=0
E2E_RESULT=0

# Cleanup function.
cleanup() {
    echo -e "${YELLOW}▶ Stopping Docker container...${NC}"
    docker compose down -v 2>/dev/null || true
    echo -e "  Container stopped"
}
trap cleanup EXIT

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

# Build and start Docker container.
echo -e "${YELLOW}▶ Building Docker image...${NC}"
if ! docker compose build --quiet; then
    echo -e "${RED}✗ Docker build failed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker image built${NC}"
echo

echo -e "${YELLOW}▶ Starting Docker container...${NC}"
docker compose up -d

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
    docker compose logs
    exit 1
fi
echo

# Run e2e tests against Docker.
echo -e "${YELLOW}▶ Running e2e tests...${NC}"
if npm run test:docker; then
    echo -e "${GREEN}✓ E2E tests passed${NC}"
else
    echo -e "${RED}✗ E2E tests failed${NC}"
    E2E_RESULT=1
fi
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
