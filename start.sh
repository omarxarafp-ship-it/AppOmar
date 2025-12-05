#!/bin/bash

# AppOmar Bot Startup Script

set -e

echo "🚀 Starting AppOmar Bot..."

# Install Node dependencies
echo "📦 Installing Node.js dependencies..."
npm ci

# Install Python dependencies
echo "🐍 Installing Python dependencies..."
python3 -m pip install -r requirements.txt -q

# Start API server in background
echo "🔧 Starting API server..."
nohup python3 api_server.py > api_server.log 2>&1 &
API_PID=$!
echo $API_PID > api_server.pid
echo "✅ API server started (PID: $API_PID)"

# Give API server time to start
sleep 2

# Start WhatsApp bot
echo "📱 Starting WhatsApp bot..."
npm run start

# Cleanup on exit
trap "kill $API_PID 2>/dev/null || true" EXIT
