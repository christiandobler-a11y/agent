# Avelio Lead Engine

Internes System für Avelio: lokale Unternehmen finden, Websites auditieren, Leads mit dem
Avelio Lead Score bewerten und über Telegram berichten.

Plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Stand: Schritt 1 (Repo-Gerüst) umgesetzt.

## Lokal starten

```sh
nvm use               # Node 22
npm install
cp .env.example .env  # Keys eintragen
docker compose up -d db
npm run check-env     # prüft die Keys live
npm run verify        # Format, Lint, Typecheck, Tests
```
