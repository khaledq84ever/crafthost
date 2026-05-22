# CraftHost

Minecraft server hosting platform — instant deploys, custom JARs, mod support.

## Quick Start

```bash
cd /home/khaled/crafthost
cp .env.example .env
npm install
npm run init-db
npm start
```

Open http://localhost:4000

## Folder Structure

```
crafthost/
├── backend/         Express API, Docker controller, auth, billing
│   ├── routes/      API route handlers
│   ├── middleware/  Auth, rate limit, error handlers
│   ├── lib/         Docker controller, RCON, modrinth, mojang
│   └── db/          SQLite schema + init
├── frontend/        Static HTML/CSS/JS (served by Express)
│   ├── css/
│   ├── js/
│   └── assets/
├── jars/            Cached server JARs (vanilla, paper, etc.)
├── uploads/         User-uploaded custom JARs
├── data/            SQLite DB + per-server world data
└── backups/         Compressed world backups
```

## Stack

- **Backend**: Node.js + Express + better-sqlite3 + JWT auth + dockerode
- **Frontend**: Vanilla HTML/CSS/JS (mobile-first, RTL+LTR)
- **Containers**: itzg/minecraft-server image, isolated per user
- **Deploy**: Railway (Dockerfile + railway.toml)

## Brand

- Emerald `#00C853` · Dark slate `#0F172A` · Gold `#FFB300`
- Fonts: Inter (English), Tajawal (Arabic)
