# SALON PRO — Gestion Financière et Administrative de Salon de Coiffure

**SALON PRO** est une application web moderne, rapide et **Hybride Hors-Ligne (IndexedDB + Neon PostgreSQL)** de gestion financière et administrative pour salon de coiffure et barbershop, conçue en français avec montants entiers en **Francs CFA (`FCFA`)**.

---

## 1. Architecture réactive en 6 Contextes transverses

1. **`SalonStoreContext` (`SalonDataContext`)** : État réactif local synchronisé sur **IndexedDB (Dexie v2)** via des transactions multi-tables atomiques (`SalonRepositoryHub`).
2. **`CloudSyncContext`** : Synchronisation bidirectionnelle **Last-Write-Wins (`updatedAt`)** entre IndexedDB locale et **Neon PostgreSQL**, authentifiée par jeton de session signé (`HMAC-SHA256`) ou code serveur optionnel (`SALON_SYNC_PIN`), avec continuité hors-ligne automatique.
3. **`PeriodFilterContext`** : Période d'analyse partagée (`Aujourd'hui`, `7 jours`, `Ce mois`, `Mois précédent`, `Année`, `Personnalisée` + `selectedMonth`) synchronisée entre Tableau de bord, Recettes, Dépenses, Personnel, Paie, Budget et Rapports.
4. **`CashSessionContext`** : État temps réel du tiroir-caisse dans la Topbar (`Caisse ouverte · XX XXX FCFA` / `Caisse fermée`), détection automatique des sessions de la veille non clôturées (`isSessionStale`) et avertissement non bloquant avec bouton *« Ouvrir la caisse maintenant »*.
5. **`QuickActionContext`** : Modales universelles accessibles depuis n'importe quel écran (`Ticket client multi-lignes`, `Dépense rapide`, `Ouverture de caisse`, `Reçu client imprimable 80mm / A5`).
6. **`WorkspaceFocusContext`** : Ciblage contextuel intelligent (`deep-link`) depuis la recherche globale `⌘K`, les *Opérations récentes* et les *Alertes proactives* directement vers l'écriture ou le filtre concerné.

---

## 2. Périmètre fonctionnel complet (11 rubriques + outils transverses)

1. **Tableau de bord (`/dashboard`)** : Cartes KPI avec évolution vs période précédente, graphiques interactifs, suivi budgétaire, opérations récentes cliquables et **alertes proactives** (caisse de la veille non clôturée, sauvegarde > 7 jours, pré-alerte budget à 85 % et dépassement à 100 %, ruptures de stock, salaires en attente, charges fixes mensuelles à régler).
2. **Gestion de caisse (`/cash`)** : Ouverture de session espèces, entrées/sorties espèces, solde théorique temps réel, **calculateur optionnel de billetage FCFA** (`10 000` à `25` FCFA) à la clôture, corrections traçables et rapport imprimable A4. *Séparation stricte entre espèces physiques et Mobile Money (`Wave`, `Orange Money`, `MTN MoMo`, `Carte`, `Virement`).*
3. **Gestion des recettes (`/revenue`)** : **Ticket Client multi-lignes** (1 à N prestations et/ou produits de revente, employé par ligne, calculateur de monnaie rendue), **paiement mixte** (ex. Espèces + Wave où seule la part espèces alimente la caisse), **consommables cabine optionnels** décrémentant le stock (`utilisation`) sans surfacturation client, **reçu client séquentiel (`REC-YYYYMMDD-XXX`) imprimable (`80mm` / `A5`)**, réintégration automatique du stock en cas d'annulation et synchronisation complète Wave ↔ Espèces à la modification.
4. **Gestion des dépenses (`/expenses`)** : **Charges fixes mensuelles récurrentes** (*Loyer, CIE, SODECI, Internet…*) validables en 1 clic avec suivi `Payé / À payer`, pont intelligent vers l'Inventaire lors d'un achat de produits capillaires pour éviter tout double comptage, filtres, justificatifs, export CSV et impression.
5. **Prestations et tarifs (`/services`)** : Catalogue tarifaire du salon, statistiques de réalisations et CA par prestation, bouton **« Encaisser » en 1 clic** pré-remplissant le Ticket Client, export CSV et grille tarifaire imprimable A4.
6. **Gestion du personnel (`/employees`)** : Fiches salariés, performance par coiffeur/barbier sur la période active, **3 bases de commission au choix** (`Prestations seules` [défaut], `Prestations + Produits vendus`, `CA global du salon`), raccourcis 1 clic vers Avance et Paie.
7. **Salaires, avances, primes et commissions (`/payroll`)** : Préparation mensuelle de la paie, **indicateur intelligent de plafond d'avance**, support des **paiements de salaire partiels (acompte + solde)** sans double déduction des avances, et **bulletin / reçu de paie imprimable** avec encadrés de signature Employé & Gérant.
8. **Inventaire des produits et consommables (`/inventory`)** : Suivi des consommables, produits de revente et produits mixtes, **recalcul automatique du CUMP (Coût Unitaire Moyen Pondéré en FCFA entiers)** lors des achats fournisseurs, seuils d'alerte, mouvements transactionnels et export CSV.
9. **Rapports et états financiers (`/reports`)** : 8 états financiers incluant le **Rapprochement par mode de paiement** (*Caisse physique espèces vs Wave vs Orange Money vs MTN MoMo…*) et le **Journal d'audit** avec comparatif lisible **Avant ➔ Après**, export CSV et aperçu imprimable.
10. **Budget et objectifs (`/budget`)** : Objectif mensuel de CA, plafonds par catégorie avec pré-alerte dès **85 %**, **prévision de fin de mois (*run-rate*)**, reconduction en 1 clic du mois précédent, export CSV et impression A4.
11. **Paramètres (`/settings`)** : Identité et logo du salon, thème clair/sombre, reçu client (`80mm` / `A5`), catégories personnalisables, **Synchronisation Cloud Neon PostgreSQL** (`Paramètres → Cloud Neon`), sauvegarde/restauration JSON complète (`SALON_PRO_BACKUP_V1`) et réinitialisation protégée par `SUPPRIMER`.

---

## 3. Configuration Neon PostgreSQL (Mode Hybride Hors-Ligne + Cloud)

1. Copiez `.env.example` vers `.env` à la racine du projet (ou configurez ces variables dans **Vercel → Settings → Environment Variables**) :
   ```env
   DATABASE_URL="postgresql://UTILISATEUR:MOT_DE_PASSE@VOTRE_HOTE.neon.tech/VOTRE_BASE?sslmode=require"
   SALON_AUTH_SECRET=""
   SALON_SYNC_PIN=""
   SALON_DEFAULT_TENANT_ID="00000000-0000-0000-0000-000000000001"
   ```
   > **Sécurité** : Ne préfixez jamais ces variables par `VITE_`. Elles sont lues uniquement côté serveur (`server/viteApiPlugin.ts` en local et `api/[...route].ts` sur Vercel).
2. Le schéma PostgreSQL est **versionné** (`server/migrations.ts`) et appliqué automatiquement au premier appel : `schema_migrations` enregistre les migrations `001_baseline` (schéma historique, 19 tables), `002_multi_tenant` (organisations, salons, `tenant_id` + RLS), `003_sessions` (sessions révocables) puis `004_sync_revisions` (journal de synchronisation delta), puis `005_memberships` (appartenances multi-salons). Le service worker (`dist/sw.js`) est généré par le build, pas par les migrations. Chaque migration s'exécute dans sa propre transaction et n'est jamais rejouée. `db/schema.sql` reste la référence lisible du schéma de base.
3. Dans l'application, ouvrez **Paramètres → Cloud Neon** puis cliquez sur **Activer la synchronisation Neon**.

### 3.1 Multi-salon : isolation et salon actif

- Le modèle suit la chaîne **`organizations` → `tenants` → données métier**. Un *tenant* est un salon (nom, `slug`, fuseau `Africa/Abidjan`).
- **Le salon n'est jamais transmis par le client.** Il provient du jeton de session signé (claim `tid`) ou, à défaut, de `SALON_DEFAULT_TENANT_ID` côté serveur. Un en-tête ou un champ `tenantId` envoyé par le navigateur est ignoré.
- **Isolation en base** : les 18 tables métier portent `tenant_id` et subissent une *Row Level Security* activée **et forcée** (`FORCE ROW LEVEL SECURITY`) — même le propriétaire des tables est filtré. La politique `tenant_isolation` s'applique en lecture (`USING`) comme en écriture (`WITH CHECK`).
- **Contexte transactionnel** : chaque opération serveur ouvre une transaction et pose `set_config('app.tenant_id', <salon>, true)` (`server/tenantContext.ts`). La portée locale garantit qu'aucun salon ne « fuit » vers la requête suivante d'une connexion mutualisée.
- **Comptes** : `salon_users` reste hors RLS (l'authentification précède la connaissance du salon) mais toutes les requêtes filtrent explicitement `tenant_id`; l'unicité d'e-mail est désormais **par salon**.
- **Première inscription** sur une base vierge : une organisation et un salon sont créés automatiquement, et l'utilisateur en devient Gérant. Les inscriptions ultérieures sans salon sont rattachées au salon par défaut et requièrent l'approbation du Gérant (`MANAGER_APPROVAL_REQUIRED`).

### 3.2 Synchronisation delta serveur-autoritaire

- **Le serveur décide**, le client propose : à chaque synchronisation, l'ordre des écritures est celui de **l'arrivée côté serveur**, plus jamais celui de l'horloge du navigateur.
- Chaque salon possède un **curseur de révision** (`sync_state.revision`, verrouillé pendant le push). Un client qui présente son curseur ne reçoit que les changements survenus depuis (`sync_changes`), y compris ceux des autres appareils.
- Réponses : `cursor`, `changes` (par table), `deleted` (suppressions). L'état complet n'est renvoyé qu'au premier échange, quand aucun curseur n'est fourni.
- Un push **sans curseur** (appareil qui n'a pas encore récupéré l'état serveur) voit ses lignes plus anciennes écartées : impossible d'écraser des données récentes avec une copie périmée.
- Côté navigateur, `mergeCloudDelta()` n'applique que les tables reçues et respecte les suppressions ; le curseur est conservé dans `localStorage`.

### 3.3 Mode hors-ligne réel (service worker)

- Après le premier chargement, l'application s'ouvre **sans réseau** : la coquille et tous les bundles sont précachés par `dist/sw.js`, généré à chaque build (liste réelle des fichiers + version dérivée de leur contenu).
- Navigation : réseau d'abord, repli sur la coquille en cache. Ressources statiques : cache d'abord (noms hachés immuables).
- **L'API n'est jamais mise en cache** : les données métier vivent dans IndexedDB et remontent via la synchronisation delta dès le retour du réseau.
- Nouvelle version : elle attend en arrière-plan et s'active sur demande, sans interrompre une saisie.
- Le service worker est désactivé en développement (aucune interférence avec le HMR).

> Vérifier le mode hors-ligne : `npm run build && npm run preview`, ouvrir l'application, puis couper le réseau (DevTools → Network → Offline) et recharger.

### 3.4 Équipe, rôles et multi-salon

- **Identité ≠ appartenance** : `salon_users` porte les identifiants et le hash du mot de passe ; la table `memberships` porte le **rôle et l'activation par salon**. Un compte peut donc travailler dans plusieurs salons avec des rôles différents.
- `GET /api/auth/tenants` liste les salons d'un compte ; `POST /api/auth/switch-tenant` bascule la session (rôle issu de l'appartenance, ancienne session révoquée).
- **Les droits sont vérifiés en base à chaque appel** : une rétrogradation prend effet immédiatement, sans attendre l'expiration du jeton ; un changement de rôle ou une désactivation révoque toutes les sessions du compte.
- **Garde de rôle par entité** : un Caissier saisit recettes, dépenses, caisse et mouvements de stock ; il ne peut pas modifier la configuration du salon, les référentiels (prestations, employés, produits), les budgets, salaires, avances ni les journaux de correction, et ne peut rien supprimer. Les tentatives refusées sont renvoyées dans `rejected` (`WRITE_FORBIDDEN_FOR_ROLE`, `DELETE_FORBIDDEN_FOR_ROLE`).

### 3.5 Sécurité, rôles et administration des comptes

- **`SALON_AUTH_SECRET` est obligatoire en production** (Vercel). Sans lui, chaque instance serverless signerait les sessions avec un secret différent et déconnecterait les utilisateurs. Génération : `openssl rand -hex 32`.
- **Les comptes utilisateurs ne transitent jamais par la synchronisation.** Un payload `SALON_PRO_BACKUP_V1` ne peut donc ni créer, ni promouvoir, ni réécrire un compte (rôle ou hash de mot de passe). Toute administration passe par des routes dédiées, réservées à une session **Gérant** :
  | Route | Méthode | Rôle | Usage |
  |---|---|---|---|
  | `/api/users` | `GET` | Gérant | Liste des comptes (jamais de hash exposé) |
  | `/api/users/provision` | `POST` | Gérant | Provisionne les comptes créés hors-ligne (création seule, jamais d'écrasement) |
  | `/api/users/:id` | `PATCH` | Gérant | Rôle, activation, identité, réinitialisation de mot de passe (haché côté serveur) |
- **Garde-fous serveur** : impossible de retirer le rôle ou de désactiver le **dernier Gérant actif**, ni de désactiver son propre compte.
- **Politique de mot de passe** : 8 caractères minimum, avec au moins une lettre et un chiffre (appliquée côté serveur **et** en mode hors-ligne).
- **Anti-bruteforce** : 5 tentatives échouées par identifiant et par IP sur 15 minutes, 30 tentatives par IP, 10 créations de compte par heure.
- **Sessions révocables** : le jeton d'accès est signé et ne dure que **15 minutes** ; il porte l'identifiant de session (`sid`) vérifié en base à chaque requête. Le **jeton de rafraîchissement** (opaque, stocké haché, durée 30 jours) est **à usage unique** : chaque rafraîchissement le fait tourner. Rejouer un jeton déjà consommé révoque toutes les sessions du compte. La déconnexion (`POST /api/auth/logout`) révoque la session immédiatement. Côté navigateur, `src/lib/sessionClient.ts` rafraîchit automatiquement avant expiration et rejoue la requête en cas de 401.
- **En-têtes de sécurité** (CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) configurés dans `vercel.json`.
- La synchronisation machine sans session (`SALON_SYNC_PIN`) reste possible pour compatibilité, mais elle est **dépréciée** et ne donne aucun accès à l'administration des comptes.

---

## 4. Installation, lancement et tests

```bash
# 1. Installer les dépendances
npm install

# 2. Lancer le serveur Full-Stack local (Frontend + API /api/*)
npm run dev

# 3. Exécuter la suite de tests automatisés (Vitest + Testing Library + fake-indexeddb)
npm test

# 4. Vérifier la qualité du code (Oxlint)
npm run lint

# 5. Compiler la version de production (TypeScript + Vite)
npm run build
```
