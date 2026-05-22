// Run: node backend/db/init.js
// Initializes DB schema + seed data
require('dotenv').config();
const db = require('./index');
console.log('✓ Database initialized at', process.env.DATABASE_PATH || './data/crafthost.db');
console.log('✓ Plans seeded:', db.prepare('SELECT COUNT(*) as c FROM plans').get().c);
process.exit(0);
