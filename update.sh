#!/bin/bash
set -e

echo "Updating Leyble Hub..."

git pull origin main

cd server && npm install --silent && node db/migrate.js && cd ..
cd client && npm install --silent && cd ..

pm2 restart all

echo ""
echo "Done! App is updated and running."
