#!/bin/bash
set -e

# ==============================================================================
# End-to-End Testing Setup Script
# ==============================================================================
# This script sets up the full e2e testing environment for esa-dono-ui,
# Kollekt, and esa-layouts-v2 with RabbitMQ.
#
# Usage: ./tests/e2e/setup-e2e.sh [--with-kollekt] [--with-overlay] [--all]
# ==============================================================================

ESA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ESA_ROOT"
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_info() {
  echo -e "${BLUE}ℹ ${1}${NC}"
}

print_success() {
  echo -e "${GREEN}✓ ${1}${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ ${1}${NC}"
}

print_error() {
  echo -e "${RED}✗ ${1}${NC}"
}

# Parse arguments
WITH_KOLLEKT=false
WITH_OVERLAY=false
WITH_ALL=false

for arg in "$@"; do
  case $arg in
    --with-kollekt) WITH_KOLLEKT=true ;;
    --with-overlay) WITH_OVERLAY=true ;;
    --all)
      WITH_KOLLEKT=true
      WITH_OVERLAY=true
      WITH_ALL=true
      ;;
  esac
done

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║      ESA End-to-End Testing Setup (esa-dono-ui + more)        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Verify we're in the right directory
if [ ! -f "tests/e2e/docker-compose.e2e.yml" ]; then
  print_error "tests/e2e/docker-compose.e2e.yml not found in $ESA_ROOT"
  exit 1
fi
print_success "Found tests/e2e/docker-compose.e2e.yml"

# Step 2: Clone repositories if needed
print_info "Checking for required repositories..."

KOLLEKT_PATH="../kollekt"
if [ "$WITH_KOLLEKT" = true ] && [ ! -d "$KOLLEKT_PATH/.git" ]; then
  print_warning "Kollekt not found at $KOLLEKT_PATH. Cloning..."
  git clone https://github.com/esamarathon/kollekt.git "$KOLLEKT_PATH"
  print_success "Kollekt cloned"
else
  if [ "$WITH_KOLLEKT" = true ]; then
    print_success "Kollekt found at $KOLLEKT_PATH"
  fi
fi

OVERLAY_PATH="../esa-layouts-v2"
if [ "$WITH_OVERLAY" = true ] && [ ! -d "$OVERLAY_PATH/.git" ]; then
  print_warning "esa-layouts-v2 not found at $OVERLAY_PATH. Cloning..."
  git clone https://github.com/esamarathon/esa-layouts-v2.git "$OVERLAY_PATH"
  print_success "esa-layouts-v2 cloned"
else
  if [ "$WITH_OVERLAY" = true ]; then
    print_success "esa-layouts-v2 found at $OVERLAY_PATH"
  fi
fi

# Step 3: Check for .env file
print_info "Checking for .env configuration..."

if [ ! -f ".env" ]; then
  print_warning ".env file not found"
  if [ -f ".env.example" ]; then
    print_info "Creating .env from .env.example..."
    cp .env.example .env
    print_success ".env created (please review and adjust values)"
  else
    print_error ".env.example not found"
    exit 1
  fi
else
  print_success ".env file exists"
fi

# Step 4: Build images
print_info "Building Docker images..."

COMPOSE_CMD="docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml"
if [ "$WITH_KOLLEKT" = true ]; then
  COMPOSE_CMD="$COMPOSE_CMD --profile with-kollekt"
fi
if [ "$WITH_OVERLAY" = true ]; then
  COMPOSE_CMD="$COMPOSE_CMD --profile with-overlay"
fi

$COMPOSE_CMD build

print_success "Docker images built"

# Step 5: Start services
print_info "Starting services..."

$COMPOSE_CMD up -d

print_success "Services started"

# Step 6: Wait for services to be healthy
print_info "Waiting for services to be healthy..."

# Wait for backend
print_info "Waiting for backend API..."
for i in {1..30}; do
  if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
    print_success "Backend API is healthy"
    break
  fi
  if [ $i -eq 30 ]; then
    print_error "Backend API failed to start"
    exit 1
  fi
  sleep 1
done

# Wait for RabbitMQ
print_info "Waiting for RabbitMQ..."
for i in {1..30}; do
  if docker exec esa-rabbitmq rabbitmq-diagnostics -q ping > /dev/null 2>&1; then
    print_success "RabbitMQ is healthy"
    break
  fi
  if [ $i -eq 30 ]; then
    print_error "RabbitMQ failed to start"
    exit 1
  fi
  sleep 1
done

# Step 7: Initialize database
print_info "Initializing database..."

if ! command -v npx &> /dev/null; then
  print_error "npx not found. Please install Node.js"
  exit 1
fi

# npx prisma requires the workspace's own node_modules (tsx, @prisma/client,
# the seed script's deps) to already be installed — npx alone will not fetch
# these on a fresh clone.
if [ ! -d "node_modules" ]; then
  print_info "Installing root workspace dependencies (npm install)..."
  npm install
fi

cd server
npx prisma migrate deploy 2>/dev/null || npx prisma migrate dev --name init
npx prisma db seed 2>/dev/null || true
cd ..

print_success "Database initialized and seeded"

# Step 8: Print summary
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete! 🎉                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Services running:"
print_success "RabbitMQ (AMQP: amqp://localhost:5672, Management: http://localhost:15672)"
print_success "Backend API (http://localhost:3001/api)"
print_success "Frontend UI (http://localhost:8080)"

if [ "$WITH_KOLLEKT" = true ]; then
  print_success "Kollekt (listening to RabbitMQ)"
fi

if [ "$WITH_OVERLAY" = true ]; then
  print_success "esa-layouts-v2 (http://localhost:3002)"
fi

echo ""
echo "Next steps:"
echo ""
echo "1. Access the application:"
echo "   • Frontend: http://localhost:8080"
echo "   • Admin UI: http://localhost:8080/admin (use your ADMIN_API_KEY from .env)"
echo "   • RabbitMQ UI: http://localhost:15672 (guest/guest)"
if [ "$WITH_OVERLAY" = true ]; then
  echo "   • Overlay: http://localhost:3002"
fi
echo ""
echo "2. Create a test donation:"
echo "   • Go to http://localhost:8080/admin/simulate"
echo "   • Enter an email and amount"
echo "   • The donation will be created and published to RabbitMQ"
echo ""
echo "3. Configure event delivery:"
echo "   • Go to http://localhost:8080/admin/destinations"
echo "   • Add a RabbitMQ destination pointing to rabbitmq:5672"
echo "   • Subscribe to donation.created events"
echo ""
echo "4. Watch messages flow:"
echo "   • Check Kollekt logs: docker logs -f esa-kollekt"
if [ "$WITH_OVERLAY" = true ]; then
  echo "   • Check Overlay logs: docker logs -f esa-layouts-v2"
fi
echo "   • Monitor RabbitMQ at http://localhost:15672"
echo ""
echo "5. Review the full testing guide:"
echo "   • See tests/e2e/docs/e2e-testing.md for detailed test scenarios"
echo ""
echo "To stop all services:"
echo "   docker compose --env-file .env -p esa-dono-e2e -f tests/e2e/docker-compose.e2e.yml down"
echo ""
