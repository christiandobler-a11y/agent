# Deploy auf Hetzner (Schritt 9)

Ziel: Avelio läuft rund um die Uhr auf einem eigenen kleinen Server, ohne deinen Mac. Der Telegram-Bot, die Worker und
die tägliche Sicherung laufen dort in Docker. Von außen ist nur SSH erreichbar; der Bot holt sich seine Nachrichten
selbst bei Telegram ab und braucht keinen offenen Port.

Dauer: einmalig etwa 30 Minuten. Kosten: etwa 5 € im Monat.

Alle Befehle unten kannst du so, wie sie sind, ins Terminal kopieren. `<IP>` ersetzt du durch die IP-Adresse deines
Servers (z. B. `128.140.12.34`).

## 1. Hetzner-Konto und Projekt

1. Auf [console.hetzner.com](https://console.hetzner.com) registrieren (Ausweis- bzw. Zahlungsprüfung dauert manchmal
   ein paar Minuten).
2. **Neues Projekt** anlegen, Name `avelio`.

## 2. SSH-Schlüssel auf dem Mac

Prüfen, ob du schon einen hast:

```sh
ls ~/.ssh/id_ed25519.pub
```

Kommt „No such file or directory“, einen anlegen (Enter für den Speicherort, ein Passwort ist empfohlen):

```sh
ssh-keygen -t ed25519
```

Den öffentlichen Teil in die Zwischenablage kopieren:

```sh
pbcopy < ~/.ssh/id_ed25519.pub
```

In der Hetzner Console im Projekt: **Security → SSH keys → Add SSH key**, einfügen, Name `Mac`.

## 3. Server anlegen

Im Projekt **Add Server**:

| Feld | Wert |
|---|---|
| Location | Nürnberg oder Falkenstein (Deutschland) |
| Image | Ubuntu 24.04 |
| Type | Shared vCPU, **x86** (Intel/AMD), 2 vCPU / 4 GB RAM (z. B. CX23, früher CX22) |
| Networking | **Public IPv4 an** (viele Firmen-Websites sind nur über IPv4 erreichbar), IPv6 an |
| SSH keys | `Mac` anhaken |
| Name | `avelio` |

Nach etwa einer Minute steht die IP-Adresse in der Übersicht. Test vom Mac aus (beim ersten Mal mit `yes` bestätigen):

```sh
ssh root@<IP> echo verbunden
```

## 4. Server einrichten

Im Avelio-Ordner auf dem Mac (nach `git pull`):

```sh
scp scripts/server-setup.sh root@<IP>:
ssh root@<IP> bash server-setup.sh
```

Das Skript aktualisiert das System und richtet Folgendes ein:

- Docker
- Firewall (nur SSH)
- automatische Sicherheitsupdates
- Auslagerungsspeicher
- tägliche Sicherung um 03:15
- einen Lese-Schlüssel für GitHub

Am Ende gibt es eine Zeile aus, die mit `ssh-ed25519` beginnt. Diese Zeile trägst du bei GitHub ein:

1. [github.com/christiandobler-a11y/agent/settings/keys](https://github.com/christiandobler-a11y/agent/settings/keys)
   → **Add deploy key**
2. Title `avelio-server`, Key = die Zeile, **„Allow write access“ nicht anhaken** → Add key

## 5. Code auf den Server holen

```sh
ssh root@<IP> git clone -b claude/ecstatic-goldberg-lsnx6n git@github.com:christiandobler-a11y/agent.git /opt/avelio
```

## 6. Schlüssel (.env) übertragen

Die `.env` von deinem Mac enthält alle Keys. Sie wird verschlüsselt über SSH kopiert und ist danach nur für root
lesbar:

```sh
scp .env root@<IP>:/opt/avelio/.env
ssh root@<IP> chmod 600 /opt/avelio/.env
```

## 7. Starten

**Zuerst den Worker auf dem Mac beenden** (im Terminal mit `npm run worker`: Ctrl+C). Der Telegram-Bot darf nur an
einer Stelle laufen.

Dann den Server starten (der erste Build dauert etwa 5 Minuten):

```sh
ssh root@<IP> "cd /opt/avelio && docker compose -f docker-compose.prod.yml up -d --build"
```

Prüfen:

```sh
ssh root@<IP> "cd /opt/avelio && docker compose -f docker-compose.prod.yml logs --tail 20 app"
```

Erwartet: `Angewendet: …` oder `Datenbank ist auf dem neuesten Stand.`, danach `avelio gestartet` mit
`"telegram":true` und `Telegram-Bot läuft`. Dann in Telegram `/status` schicken.

Nach etwa zwei Minuten zeigt `docker compose -f docker-compose.prod.yml ps` den Zustand `healthy`.

## 8. Sicherung testen

```sh
ssh root@<IP> "cd /opt/avelio && docker compose -f docker-compose.prod.yml run --rm backup"
```

Erwartet: `Sicherung geschrieben: /backups/avelio-….dump`. Die Sicherungen liegen auf dem Server unter
`/opt/avelio/backups/`. Es werden 14 Tage aufbewahrt, und gesichert werden alle Avelio-Tabellen. Eine Kopie auf den Mac:

```sh
scp -r root@<IP>:/opt/avelio/backups ~/avelio-backups
```

## 9. Ausfall-Alarm (empfohlen, kostenlos)

Avelio meldet sich alle 5 Minuten bei einem Uptime-Dienst. Bleibt das aus (Server weg, Datenbank weg), bekommst du
eine Mail.

1. Auf [healthchecks.io](https://healthchecks.io) registrieren, **Add Check**: Name `Avelio`, Period 5 Minuten,
   Grace 10 Minuten.
2. Die Ping-URL kopieren (`https://hc-ping.com/…`).
3. Auf dem Server in die `.env` eintragen und neu starten:

```sh
ssh root@<IP>
nano /opt/avelio/.env
```

Unten die Zeile `HEALTHCHECK_URL=https://hc-ping.com/…` ergänzen und speichern (Ctrl+O, Enter, Ctrl+X). Danach:

```sh
cd /opt/avelio && docker compose -f docker-compose.prod.yml up -d
exit
```

## 10. Datenbank absichern (optional)

In Supabase unter **Database → Settings → Network Restrictions** nur noch die Server-IP (`<IP>/32`) erlauben. Danach
funktionieren `npm run cli -- …`-Befehle vom Mac aus nur, wenn du dort auch deine eigene IP einträgst. Diese wechselt
bei den meisten Internetanschlüssen gelegentlich. Daher lieber erst, wenn alles stabil läuft.

## 11. Vorschau-Seiten für Prototypen (vorschau.avelio.digital)

Avelio baut auf Knopfdruck (Lead-Karte → „🎨 Prototyp bauen“) einen Website-Entwurf für einen Lead. Damit du ihn per
Link zeigen kannst, liefert ein kleiner Webserver (Caddy) die Entwürfe unter `https://vorschau.avelio.digital/…` aus.
Die Seiten sind nicht bei Google auffindbar und nur mit dem Link erreichbar (Zufallsteil im Pfad).

1. **DNS bei IONOS:** Domains & SSL → avelio.digital → DNS → Eintrag hinzufügen: Typ **A**, Hostname **vorschau**,
   Zeigt auf **167.233.61.90** (deine Server-IP). Gibt es für `vorschau` schon einen AAAA-Eintrag, diesen löschen.
   Es dauert meist 5 bis 30 Minuten, bis der Eintrag gilt.
2. **Firewall öffnen** (einmalig, auf dem Server):

   ```sh
   ufw allow 80/tcp && ufw allow 443
   ```

3. **.env ergänzen** (`nano /opt/avelio/.env`), unten anfügen:

   ```
   PREVIEW_DOMAIN=vorschau.avelio.digital
   PREVIEW_BASE_URL=https://vorschau.avelio.digital
   COMPOSE_PROFILES=preview
   ```

4. **Neu starten:** `bash /opt/avelio/scripts/deploy.sh`. Caddy holt sich beim ersten Aufruf selbst ein
   HTTPS-Zertifikat. Test: `https://vorschau.avelio.digital/` zeigt „Nicht gefunden“ (gewollt, es gibt keine
   Übersicht).

Alte Entwürfe löscht Avelio nach 60 Tagen (`config/prototype.yaml`), außer der Lead ist im Gespräch.

## 12. Postfach für das Morgen-Paket (Versand per Knopf, Antworten erkennen)

Avelio schickt Mails nur, wenn du in Telegram auf „📤 Senden“ tippst, und zwar über dein eigenes Postfach. Die Mail
landet bei dir unter „Gesendet“, Antworten erkennt Avelio automatisch (Status „geantwortet“, Nachfassen stoppt, du
bekommst sofort eine Meldung). Dafür braucht Avelio ein **App-Passwort**, nicht dein normales Passwort:

- **iCloud:** [account.apple.com](https://account.apple.com) → Anmeldung und Sicherheit → App-spezifische Passwörter
  → „+“, Name `Avelio`. Anbieter `icloud`.
- **Gmail:** Google-Konto → Sicherheit → Bestätigung in zwei Schritten → App-Passwörter. Anbieter `gmail`.
- **GMX / web.de:** Einstellungen → POP3/IMAP aktivieren, dann das normale Passwort oder ein App-Passwort. Anbieter
  `gmx` bzw. `webde`.

Auf dem Server in die `.env` (`nano /opt/avelio/.env`):

```
OUTREACH_MAIL_ADDRESS=deine-adresse@…
OUTREACH_MAIL_PASSWORD=das-app-passwort
OUTREACH_MAIL_PROVIDER=icloud
```

Danach `bash /opt/avelio/scripts/deploy.sh`. Ab dem nächsten Morgen um 7 Uhr kommt das Paket („Heute: 0/15“), sofort
geht es mit `/heute`. Grenzen: höchstens 40 neue Mails am Tag (`config/mail.yaml`), geplant sind 15, nach zwei Wochen
30 (`config/autopilot.yaml`). Ohne App-Passwort funktioniert alles auch, nur mit „✅ Selbst gesendet“ statt „Senden“.

## Betrieb

| Was | Befehl (auf dem Server, nach `ssh root@<IP>`) |
|---|---|
| Neue Version einspielen | `bash /opt/avelio/scripts/deploy.sh` |
| Logs live ansehen | `cd /opt/avelio && docker compose -f docker-compose.prod.yml logs -f app` (beenden mit Ctrl+C) |
| Status | `cd /opt/avelio && docker compose -f docker-compose.prod.yml ps` |
| Neu starten | `cd /opt/avelio && docker compose -f docker-compose.prod.yml restart app` |
| Anhalten | `cd /opt/avelio && docker compose -f docker-compose.prod.yml stop app` |
| Kosten, Läufe, Erklärungen | `cd /opt/avelio && docker compose -f docker-compose.prod.yml exec app node dist/cli.js costs` (statt `costs` auch `runs`, `explain <Firma>`, `calibrate`) |

Bei einem Absturz startet Docker Avelio von selbst neu (`restart: unless-stopped`), auch nach einem Server-Neustart.
Abgebrochene Jobs übernimmt der nächste Start.

Auf dem Mac weiterhin `npm run cli -- …` verwenden (gleiche Datenbank), aber **nicht** mehr `npm run worker`.

## Sicherung zurückspielen (nur im Notfall)

Überschreibt die Avelio-Tabellen in Supabase mit dem Stand der Sicherung. Vorher Avelio anhalten:

```sh
cd /opt/avelio
docker compose -f docker-compose.prod.yml stop app
ls backups
docker compose -f docker-compose.prod.yml run --rm --entrypoint sh backup -c 'pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" /backups/avelio-JJJJ-MM-TT_HHMM.dump'
docker compose -f docker-compose.prod.yml start app
```

## Was wo liegt

- `Dockerfile`: Image auf Basis des offiziellen Playwright-Images (Chromium passt zur Playwright-Version), läuft
  als normaler Benutzer, nicht als root. Vor dem Start wendet es neue Migrationen an (`docker/entrypoint.sh`).
- `docker-compose.prod.yml`: Dienst `app`, Sicherung `backup` (Profil, läuft nur per Cron bzw. von Hand).
- `src/health.ts`: Lebenszeichen jede Minute (Datenbank-Test → Datei für den Docker-Healthcheck, Ping an
  `HEALTHCHECK_URL`).
- Screenshots liegen im Docker-Volume `app-data`, nicht im Repo.
