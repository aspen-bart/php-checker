# Website Monitor (php-checker)

Interne tool van Aspen Digital: controleert elke 10 minuten of websites online zijn en of ze gehackt lijken.

- Online/offline, HTTP-status en laadtijd
- Screenshot van de homepage vergeleken met de vorige check (max. 2 screenshots per site)
- Hack-signalen: defacement-teksten, verdachte code, spam-injecties, cloaking, redirects, nieuwe externe scripts
- Offline-meldingen op de pagina zelf (onderhoud, account suspended, hack-melding) → automatisch Offline
- Handmatige Offline-tag per website
- PHP-versie (als de server die meestuurt)
- **Companies** (Aspen Digital, Outtask, Ultimum, Digital Sky): bulk toewijzen, filter per tabel én overkoepelend filter bovenin
- Pagina's: Websites, Checks (sorteren/filteren), Meldingen (+ pop-ups, geluid, bureaubladmeldingen)

## Lokaal starten (Windows)

Vereist Node.js 22.13+ en Microsoft Edge of Chrome.

```bat
start.bat
```

of `npm install` en `npm start`. Daarna: http://localhost:4300

## Online draaien (Docker)

Werkt op elke server met Docker (VPS, Azure, DigitalOcean, Hetzner, …). Chromium zit in de image.

```bash
git clone https://github.com/aspen-bart/php-checker.git
cd php-checker
echo "AUTH_PASS=kies-een-sterk-wachtwoord" > .env
docker compose up -d --build
```

De tool draait dan op poort 4300 met inlog (gebruiker `admin`, wachtwoord uit `.env`).
Zet er bij voorkeur een reverse proxy met HTTPS voor (bv. Caddy of nginx).

## Data meenemen (seed)

`seed/seed.json.gz` bevat alle companies, websites, checks en meldingen.
Een **nieuwe installatie met lege database laadt deze automatisch in**, zodat online
dezelfde historie staat als lokaal. Screenshots zitten er niet in; die worden in de eerste ronde opnieuw gemaakt.

Nieuwe export maken (bv. vlak voor het online zetten):

```bash
npm run export
git add seed && git commit -m "Seed bijgewerkt" && git push
```

Zonder seed wordt bij de eerste start `sites.txt` ingeladen.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | |
|---|---|---|
| `PORT` | 4300 | |
| `HOST` | 127.0.0.1 (Docker: 0.0.0.0) | `0.0.0.0` om op het netwerk te delen |
| `AUTH_USER` | admin | gebruikersnaam voor inloggen |
| `AUTH_PASS` | – | wachtwoord; **verplicht als de tool online staat** |
| `INTERVAL_MIN` | 10 | minuten tussen rondes |
| `CONCURRENCY` | 8 | sites tegelijk |
| `RETENTION_DAYS` | 14 | bewaartermijn checks |
