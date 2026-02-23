#!/bin/bash
# Kolaybase CLI Demo Script
# This script demonstrates the key features of the CLI

set -e

echo "════════════════════════════════════════════════════════"
echo "  Kolaybase CLI Demo"
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
step "Checking if Kolaybase CLI is installed..."
if ! command -v kb &> /dev/null; then
    echo "Kolaybase CLI is not installed."
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
kb --version

# Show help
step "Displaying available commands..."
kb --help

# Login (skip in demo, show command)
info "Next step would be: kb login"
echo "This authenticates you with your Kolaybase account."

# Init project (skip in demo, show command)
info "To initialize a new project: kb init --name 'My Project'"
echo "This creates a new project and links it to your account."

# Show status command
step "Checking local environment status..."
kb status || true

# Show projects command
info "To list all projects: kb projects"
echo "This shows all projects in your account."

# Database commands
echo ""
echo "Database Management:"
echo "  kb db push    - Push schema to database"
echo "  kb db pull    - Pull schema from database"
echo "  kb db reset   - Reset database"
echo "  kb db seed    - Seed database"

# Code generation
echo ""
echo "Code Generation:"
echo "  kb gen types              - Generate TypeScript types"
echo "  kb gen client --lang ts   - Generate TypeScript client"
echo "  kb gen client --lang py   - Generate Python client"

# Logs
echo ""
echo "Monitoring:"
echo "  kb logs --follow          - Follow container logs"
echo "  kb logs --sql --follow    - Follow SQL audit logs"

# Secrets
echo ""
echo "Secrets Management:"
echo "  kb secrets list           - List all secrets"
echo "  kb secrets set KEY VALUE  - Set a secret"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Demo Complete!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Try these commands:"
echo "  1. kb login"
echo "  2. kb init"
echo "  3. kb start"
echo "  4. kb status"
echo ""
echo "For more information:"
echo "  kb --help"
echo "  https://github.com/yourusername/v0-kolaybase"
echo ""
