#!/bin/bash
# Basefyio CLI Installation Script

set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║         Basefyio CLI Installation Script             ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version 20 or higher is required."
    echo "Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    exit 1
fi

echo "✅ npm $(npm -v) detected"
echo ""

# Get current directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "📦 Installing dependencies..."
npm install

echo ""
echo "🔨 Building CLI..."
npm run build

echo ""
echo "🔗 Linking CLI globally..."
npm link

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║          ✅ Installation Complete!                     ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "You can now use the 'basefyio' command from anywhere."
echo ""
echo "Quick Start:"
echo "  1. basefyio login"
echo "  2. basefyio init"
echo "  3. basefyio start"
echo ""
echo "For help:"
echo "  basefyio --help"
echo ""
echo "Documentation:"
echo "  README.md - Complete guide"
echo "  QUICK_REFERENCE.md - Command cheatsheet"
echo "  EXAMPLES.md - Usage examples"
echo ""
echo "To uninstall:"
echo "  npm unlink -g basefyio-cli"
echo ""
