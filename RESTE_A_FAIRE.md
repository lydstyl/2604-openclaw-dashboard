# Dashboard (openclaw-dash) — détail du reste à faire

Audit du 24/11/2026 (Luna) — app : `/home/lydstyl/apps/openclaw-dash` (dashboard.lan :3015)

## 1. Timestamp — fraîcheur des infos

**État actuel** : les cartes cachent leurs données avec des TTL hétérogènes,
sans aucun affichage de fraîcheur côté page :

| Donnée | Cache / source |
|---|---|
| Météo | TTL 15 min (stale accepté si API KO) |
| Statut LLM (Pour IA) | TTL 10 s |
| État watchdog | cache 60 s |
| Vitesse LLM | fichier `data/llm-speed.json` (collecteur) |
| Tâches Pour IA | fichier `data/pour-ia.json` (dispatch) |
| Énergie | `data/energy_prices.json` + relevés Zigbee |

**À faire** :
1. Backend : exposer `updated_at` (ISO) dans le JSON de chaque carte à données
   (GTD Pour IA, Vitesse LLM, Énergie, PC).
2. Front (`lib/page.js`) : ligne « maj il y a X min » sous le titre de chaque
   carte concernée.
3. Badge « ⚠️ infos > 2 min » (orange) si `updated_at` est plus vieux que 2 min —
   c'est le seuil demandé par Gabriel.
4. Test unitaire du calcul « il y a X min » + du badge stale (lib/dates.js existe déjà).

## 2. Archi — clean archi + tests + env dev

**État actuel (git status)** :
```
 M index.js            2521 lignes (~200 fonctions) — monolithe partiel
 M docker-compose.yml  (prod uniquement, port 3015)
?? lib/                EXTRAITS NON COMMITTÉS : dates, energy, pc, pour-ia, render, usage, page.js (2369 l.)
?? __tests__/          7 fichiers NON COMMITTÉS — 86 tests PASSENT (vitest, 3,4 s)
```

**À faire** :
1. **Committer la refacto en cours** : `lib/` + `__tests__/` sont en untracked —
   le travail est fait mais volé au dépôt.
2. **Terminer l'extraction d'index.js** : isoler les adaptateurs I/O restants
   (SSH sonde, watchdog, LLM224, pour-ia locks) dans `lib/` ; index.js ne doit
   contenir que routes + wiring (convention du header index.js).
3. **Tests** : unitaires OK (86 ✅) ; ajouter des tests e2e sur les routes
   principales (`/`, `/api/*`) — un `e2e.test.js` existe, l'étendre.
4. **Env dev manquant** : créer `docker-compose.dev.yml` + `dev.openclaw-dash.lan`
   (convention `dev.<app>.lan`, cf. skill dev-env et le `dashboard` app qui a le sien).
   Le compose prod mount `./index.js` et `./lib` en ro → l'env dev doit pointer
   sur le même dossier pour tester le code live.

## 3. Freelance — commits + workly + synthèse heures + facture

**État actuel** : aucune carte Freelance dans le dashboard.
Sources : `2509-workly` (workly.lan) = front statique, données en **localStorage**
(clé dans `src/constants.js`), API `/health` + `/` uniquement.
`2510-invoices` = app facturation.

**À faire** :
1. **Export workly** : bouton « Exporter JSON » dans work-tracker (localStorage →
   fichier) ou endpoint POST ; déposer le JSON dans `openclaw-dash/data/`.
   Sans ça, le dashboard ne peut pas lire les heures.
2. **Carte Freelance** dans le dashboard (`lib/` + section page.js) :
   - Commits : `git log --author --since=7d --oneline` sur les repos freelances
     (liste à confirmer avec Gabriel : quels repos comptent ?)
   - Heures workly par jour/semaine (depuis le JSON exporté)
   - Synthèse : heures × taux → montant estimable
   - Facture : lien vers l'app invoices + statut (à faire / envoyée)
3. Décider du périmètre : quels clients/repos = « freelance » pour le comptage
   de commits (question à trancher avec Gabriel).

## Ordre suggéré
1. Commit de la refacto (5 min, débloque tout)
2. Timestamp + badge stale (petit, visible immédiatement)
3. Env dev (convention déjà posée sur l'autre dashboard)
4. Freelance (le plus gros — nécessite l'export workly + périmètre commits)
