#!/bin/bash

set -e

echo "🚀 MediSync ABDM - Setup Script"
echo "================================"

echo "📦 Installing dependencies..."
npm install

echo "🔑 Generating RSA keys..."
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

echo "📝 Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ .env file created. Please update with your configuration."
else
    echo "⚠️  .env file already exists. Skipping..."
fi

echo "🗄️  Generating Prisma client..."
npx prisma generate

echo "📁 Creating required directories..."
mkdir -p logs uploads

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Update .env file with your configuration"
echo "2. Start PostgreSQL and Redis"
echo "3. Run: npm run prisma:migrate"
echo "4. Run: npm run dev"
