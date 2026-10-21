# Website Monitor (php-checker)

Interne tool van Aspen Digital: controleert elke 10 minuten of klantwebsites online zijn en of ze gehackt lijken.

- Online/offline, HTTP-status en laadtijd
- Screenshot van de homepage vergeleken met de vorige check (max. 2 screenshots per site)
- Hack-signalen: defacement-teksten, verdachte code, spam-injecties, cloaking, redirects, nieuwe externe scripts
- Offline-meldingen op de pagina zelf (onderhoud, account suspended, hack-melding) → automatisch Offline
- Handmatige Offline-tag per website
- PHP-versie (als de server die meestuurt)
- Pagina's: Websites, Checks (sorteren/filteren), Meldingen (+ pop-ups, geluid, bureaubladmeldingen)

## Starten

Vereist Node.js 22.13+ en Microsoft Edge (of Chrome).

```bat
start.bat
```

of

```bash
npm install
npm start
```

Daarna: http://localhost:4300

De websitelijst wordt bij de eerste start ingeladen uit `sites.txt`. Gegevens en screenshots staan in `data/`.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | |
|---|---|---|
| `PORT` | 4300 | |
| `HOST` | 127.0.0.1 | `0.0.0.0` om op het netwerk te delen |
| `INTERVAL_MIN` | 10 | minuten tussen rondes |
| `CONCURRENCY` | 8 | sites tegelijk |
| `RETENTION_DAYS` | 14 | bewaartermijn checks |
