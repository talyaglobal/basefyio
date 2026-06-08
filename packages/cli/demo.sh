#!/bin/bash
# Basefyio CLI Demo Script
# This script demonstrates the key features of the CLI

set -e

echo "════════════════════════════════════════════════════════"
echo "  Basefyio CLI Demo"
echo "════════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

step() {
  echo ""
  echo -e "${BLUE}▸ $1${NC}"
  echo ""
}

success() {
  echo -e "${GREEN}✓ $1${NC}"
}

info() {
  echo -e "${YELLOW}ℹ $1${NC}"
}

# Check if CLI is installed
step "Checking if Basefyio CLI is installed..."
if ! command -v basefyio &> /dev/null; then
    echo "Basefyio CLI is not installed."
    echo "Installing from local build..."
    cd "$(dirname "$0")"
    npm run build
    npm link
    success "CLI installed successfully"
else
    success "CLI already installed"
fi

# Show version
step "Checking CLI version..."
basefyio --version

# Show help
step "Displaying available commands..."
basefyio --help

# Login (skip in demo, show command)
info "Next step would be: basefyio login"
echo "This authenticates you with your Basefyio account."

# Init project (skip in demo, show command)
info "To initialize a new project: basefyio init --name 'My Project'"
echo "This creates a new project and links it to your account."

# Show status command
step "Checking local environment status..."
basefyio status || true

# Show projects command
info "To list all projects: basefyio projects"
echo "This shows all projects in your account."

# Database commands
echo ""
echo "Database Management:"
echo "  basefyio db push    - Push schema to database"
echo "  basefyio db pull    - Pull schema from database"
echo "  basefyio db reset   - Reset database"
echo "  basefyio db seed    - Seed database"

# Code generation
echo ""
echo "Code Generation:"
echo "  basefyio gen types              - Generate TypeScript types"
echo "  basefyio gen client --lang ts   - Generate TypeScript client"
echo "  basefyio gen client --lang py   - Generate Python client"

# Logs
echo ""
echo "Monitoring:"
echo "  basefyio logs --follow          - Follow container logs"
echo "  basefyio logs --sql --follow    - Follow SQL audit logs"

# Secrets
echo ""
echo "Secrets Management:"
echo "  basefyio secrets list           - List all secrets"
echo "  basefyio secrets set KEY VALUE  - Set a secret"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Demo Complete!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Try these commands:"
echo "  1. basefyio login"
echo "  2. basefyio init"
echo "  3. basefyio start"
echo "  4. basefyio status"
echo ""
echo "For more information:"
echo "  basefyio --help"
echo "  https://github.com/yourusername/v0-basefyio"
echo ""
