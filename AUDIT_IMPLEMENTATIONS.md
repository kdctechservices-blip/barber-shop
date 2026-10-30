# AUDIT COMPLET — SALON PRO face à la feuille de route SaaS (`IMPLEMENTATIONS.md`)

> **Objet** : analyser l'intégralité du dépôt `kdctechservices-blip/barber-shop` en suivant, point par point, les directives du document `IMPLEMENTATIONS.md` (vision SaaS multi-tenant, phases 1 → 5, portail éditeur, offres commerciales, choix stratégiques), tout en vérifiant la conformité aux règles permanentes de `AGENTS.md`.
>
> **Date** : 30 octobre 2026 · **Branche** : `arena/139c7e36-barber-shop` · **Commit analysé** : `74a1d91` (+ correctif P0 appliqué pendant l'audit, voir §1.4)
> **Périmètre** : 100 % du code versionné (frontend React, serveur API, schéma PostgreSQL, tests, configuration de déploiement).
> **Nature** : audit statique + exécution réelle des chaînes de validation (`lint`, `test`, `build`) + revue de sécurité et d'architecture. Aucune modification fonctionnelle hors du correctif P0 explicitement isolé.
>
> **Mise à jour Sprint 1 (30/10/2026)** : les constats critiques n° 2 (escalade via `/api/sync`) et n° 3 (administration des comptes) sont traités, ainsi que le durcissement de l'authentification et la CI. Voir §11 pour le suivi détaillé et les points restants.

---

## 0. Synthèse exécutive

### 0.1 Verdict en une phrase

Le produit est **un excellent logiciel de gestion financière mono-salon** (cœur métier ≈ 85 % abouti, tests verts, code propre, UX riche), mais il ne possède **aucune des fondations techniques d'un SaaS multi-tenant** décrites dans `IMPLEMENTATIONS.md` : il n'existe ni notion de tenant, ni isolation PostgreSQL, ni abonnements, ni gestion fine des rôles, ni portail éditeur. **L'écart au périmètre SaaS visé est d'environ 78 %.**

### 0.2 Scores de maturité par phase de la feuille de route

Légende : `0 %` = inexistant · `25 %` = socle partiel · `50 %` = à parité fonctionnelle partielle · `75 %` = exploitable avec réserves · `100 %` = production-ready.

| Phase (`IMPLEMENTATIONS.md` §6) | Périmètre | Maturité | Constat |
|---|---|---|---|
| **Phase 1 — Fondations SaaS** | Multi-tenant, auth, RBAC, abonnements, sauvegarde, audit/sécurité | **30 %** | Auth solide (PBKDF2 + HMAC, local + cloud), 2 rôles seulement, sauvegarde JSON manuelle, journal de corrections financières. **Absents** : tenant, RLS, abonnements, audit sécurité, sauvegarde automatique, révocation de session. |
| **Phase 2 — Expérience client** | Agenda, réservation en ligne, CRM, fidélité, notifications | **5 %** | Aucun modèle de rendez-vous, aucun client (juste un `clientName` texte libre), aucune fidélité, aucun canal WhatsApp/SMS. |
| **Phase 3 — Gestion professionnelle** | Stock avancé/fournisseurs, planning, rapports financiers, multi-agences, paiements | **50 %** | Cœur financier très solide (caisse, CUMP, paie, commissions, 8 états financiers). Manquent fournisseurs/BC, planning/présences, multi-agences, intégrations de paiement. |
| **Phase 4 — Innovation** | SALON AI, prévisions, automatisations, mini-sites, portefeuille client | **8 %** | Seuls le *run-rate* budgétaire et les alertes proactives existent. Aucun mini-site public, aucun portail client, aucun assistant. |
| **Phase 5 — Éditeur SaaS** | Console super-admin, abonnements, facturation SaaS, support, statistiques | **0 %** | Aucun socle (pas de table `tenants`, pas de rôle plateforme, aucune route d'administration). |
| **Global pondéré** | — | **≈ 22 %** | Le produit actuel est un *mono-tenant on-premise-like*, pas encore une plateforme. |

### 0.3 Les six constats majeurs

1. **Aucune isolation multi-tenant (critique).** Toutes les tables PostgreSQL sont indexées par `id` seul, sans `tenant_id`, sans RLS. L'identifiant du salon est même **codé en dur** (`salon-main`) côté serveur (`server/syncEngine.ts:366`), et la base locale porte un nom unique (`SalonProLocalDB`, `src/db/database.ts:51`). Deux salons partageant le même `DATABASE_URL` partageraient **100 % de leurs données**.
2. **Escalade de privilèges via la synchronisation (critique).** Le payload de synchronisation transporte les comptes **avec leur `passwordHash` et leur `role`** (`src/domain/models/index.ts:416`), et le serveur les *upsert* sans contrôle (`server/syncEngine.ts:802-830`). Un caissier authentifié peut donc se promouvoir Gérant ou écraser le mot de passe du Gérant en poussant un payload forgé. Voir §6.1.
3. **Autorisation uniquement côté navigateur (élevée).** Le rôle n'est vérifié que par `RequireManagerRole` (`src/app/router.tsx:107`) ; aucune route `/api/*` ne contrôle le rôle. Un jeton Caissier donne accès à **toute** la comptabilité, la paie et les paramètres via `/api/sync/pull`.
4. **Modèle de données incomplet face à la vision.** Zéro entité `Appointment`, `Client`, `LoyaltyAccount`, `Supplier`, `PurchaseOrder`, `Subscription`, `Tenant`, `FeatureFlag`, `AuditEvent` (sécurité). Le « client » n'existe que comme chaîne libre sur une recette.
5. **Synchronisation non scalable.** Chaque synchronisation pousse **l'intégralité de l'état** (19 tables) dans une transaction, avec un plafond de 15 Mo (`server/apiHandler.ts:67`), en résolution *Last-Write-Wins* sur un `updated_at` **fourni par le client** (donc falsifiable et sensible aux dérives d'horloge). Coût O(N) par appel.
6. **Violation de la règle n° 1 d'`AGENTS.md` — corrigée pendant l'audit.** Un catalogue de **38 prestations + 5 catégories** (« Fresh Barber ») était injecté automatiquement dans toute base vierge (`src/db/repositories/salonRepositories.ts`, suppression de `seedFreshBarberCatalogIfNeeded`). C'était la **cause unique des 3 tests en échec**. Après correctif : `lint` 0 erreur, **49/49 tests verts**, build OK.

### 0.4 Recommandation stratégique

> **Ne pas développer la Phase 2 avant d'avoir terminé la Phase 1.** Ajouter agenda, CRM et fidélité sur un modèle mono-tenant obligerait à migrer deux fois le schéma, les IndexedDB des utilisateurs et les payloads de synchronisation. L'ordre le plus rentable est : **(1)** isolation multi-tenant + autorisation serveur + correctif d'escalade ; **(2)** abonnements + *feature flags* + console éditeur (monétisation immédiate) ; **(3)** agenda/réservation en ligne + notifications WhatsApp (acquisition) ; **(4)** reste de la Phase 3/4.

Réponses argumentées aux 4 choix de `IMPLEMENTATIONS.md` §7 : voir §4.7.

---

## 1. Méthode et état de validation

### 1.1 Ce qui a été inspecté

| Couche | Fichiers | Lignes |
|---|---|---|
| Frontend métier (`src/`) | 97 fichiers (95 TS/TSX), 36 composants, 13 pages, 7 contextes | **29 026** (hors tests) |
| Tests (`src/test/`) | 11 fichiers, 49 tests | **3 315** |
| Serveur + API (`server/`, `api/`) | 7 fichiers | **2 111** |
| Base de données | `db/schema.sql` (234 lignes), `server/neonSchema.ts` (230 lignes) | 19 tables × 3 couches |
| Configuration | `package.json`, `vite/vitest/tsconfig`, `vercel.json`, `supabase/config.toml`, `.env.example`, `.oxlintrc.json` | — |

### 1.2 Chaînes de validation exécutées

| Commande | Résultat **avant** correctif | Résultat **après** correctif |
|---|---|---|
| `npm run lint` (Oxlint, 116 règles) | 0 erreur, 0 avertissement (104 fichiers) | **0 erreur, 0 avertissement** |
| `npm test` (Vitest, 11 fichiers) | **46/49** — 3 échecs | **49/49** ✅ |
| `npm run build` (tsc -b + Vite) | OK | **OK** (1,31 Mo JS, alerte chunk > 500 kB) |

Détail des 3 échecs initiaux — **tous causés par le même défaut** :

1. `src/test/neonSync.test.ts` — « initialise une base vierge sans aucune donnée fictive » : attendu 0 prestation, obtenu **38**.
2. `src/test/authFlows.test.tsx` — « supprime automatiquement toutes les données mocks résiduelles » : attendu 1 prestation réelle, obtenu **39**.
3. `src/test/servicesConfig.test.tsx` — expiration à 15 s : le rendu de la page Prestations avec 38 cartes supplémentaires dépasse le délai ; le test **passe en 4,3 s** dès que le pré-remplissage est désactivé.

> Preuve de causalité : test de contrôle exécuté avec `buildFreshBarberCatalog()` renvoyant des listes vides → **11/11 tests verts** sur les 3 fichiers concernés en 11 s. Le défaut était donc bien l'injection du catalogue, pas un problème d'environnement.

### 1.3 Ce qui n'a pas pu être validé (limites de l'audit)

- Aucun test d'intégration contre une **vraie** base Neon/Supabase (les tests utilisent un faux pool SQL) : le comportement réel de PostgreSQL (verrous, RLS, volume) n'est pas mesuré.
- Aucun test de charge ni mesure de performance de synchronisation à 10 000+ écritures.
- Aucun test d'intrusion automatisé (les vulnérabilités du §6 sont issues de revue de code, pas d'exploitation effective).
- Les estimations d'effort (§8) sont **indicatives** : 1 développeur senior, familiarisé avec la base de code, assisté par IA.

### 1.4 Correctif appliqué pendant l'audit (P0-0, réversible)

**Problème** : `SalonRepositoryHub.ensureInitialized()` appelait `seedFreshBarberCatalogIfNeeded()`, qui insérait 38 prestations et 5 catégories dans toute base neuve (et dans toute base existante ne portant pas encore le marqueur `freshBarberCatalogSeededAt`). Violation directe d'`AGENTS.md` §1 (« à l'initialisation, seules les catégories comptables structurelles sont créées ») et cause des 3 tests rouges.

**Correctif (2 fichiers, -62/+14 lignes)** :

- `src/db/repositories/salonRepositories.ts` : suppression de la méthode `seedFreshBarberCatalogIfNeeded`, de son appel, et de l'import ; à l'initialisation, seules `buildSystemCategories()` sont écrites.
- `src/db/freshBarberCatalog.ts` : **conservé** (données métier réelles, utiles à une importation explicite) mais désormais **inutilisé** et documenté en tête de fichier comme « gabarit — jamais injecté automatiquement ». Piste d'évolution : le brancher derrière une action explicite du Gérant (« Importer une grille tarifaire »), jamais au démarrage.
- **Aucune donnée existante n'a été supprimée** : les installations ayant déjà reçu les 38 prestations les conservent. Une purge rétroactive a été volontairement écartée (destructrice pour la grille tarifaire de l'opérateur actuel) ; voir l'annexe E pour un script de nettoyage optionnel.

---

## 2. Cartographie de l'existant

### 2.1 Stack technique

- **Frontend** : React 19.3 + React Router 7.18 + Vite 8.3 + TypeScript 7.0, Dexie 4.4 (IndexedDB), Recharts 3.10, Framer Motion 14, Lucide, Tailwind-like design system maison (`src/components/ui`, `patterns`, `reui`).
- **Backend** : API *serverless* Node (Vercel `api/[...route].ts`) + plugin Vite de développement (`server/viteApiPlugin.ts`) ; `pg` 8 vers Neon PostgreSQL.
- **Sécurité** : `node:crypto` — PBKDF2-SHA-256 (100 000 itérations) pour les mots de passe, HMAC-SHA-256 pour les jetons de session (`s1.<payload>.<sig>`), comparaison en temps constant.
- **Qualité** : Oxlint, Vitest + Testing Library + `fake-indexeddb` + jsdom, `tsc -b` strict.

### 2.2 Architecture réelle des données

```
Navigateur                                   Cloud (facultatif)
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ React UI (13 pages)          │             │ Neon PostgreSQL (19 tables)  │
│  ↕ 7 contextes               │  /api/sync   │  id PK, updated_at TEXT      │
│ SalonRepositoryHub (3 608 l) │ ───────────► │  payload_json JSONB          │
│  ↕ Dexie v4                  │ ◄─────────── │  Aucun tenant_id, aucune RLS │
│ IndexedDB "SalonProLocalDB"  │  LWW complet │  salon_users (email UNIQUE)  │
│  19 tables, 1 salon unique   │              └──────────────────────────────┘
└──────────────────────────────┘
```

Trois définitions de schéma maintenues **à la main** et actuellement **identiques** (vérifié par `diff`) : `db/schema.sql`, `server/neonSchema.ts`, `src/db/database.ts`. C'est une triple source de vérité : toute évolution doit être écrite trois fois (risque de dérive élevé).

### 2.3 Les 19 tables métier

| # | Table | Rôle | Prête multi-tenant ? |
|---|---|---|---|
| 1 | `salon_info` | Identité du salon (`id` forcé à `salon-main`) | ❌ |
| 2 | `app_settings` | Thème, reçu, hygiène des données | ❌ |
| 3 | `categories` | Catégories comptables + prestations | ❌ |
| 4 | `services_catalog` | Prestations, variantes, consommables, commissions | ❌ |
| 5 | `employees` | Salariés, rémunération, commissions | ❌ |
| 6 | `revenues` | Recettes / lignes de tickets | ❌ |
| 7 | `expenses` | Dépenses, charges récurrentes | ❌ |
| 8 | `recurring_expenses` | Modèles de charges fixes | ❌ |
| 9 | `cash_sessions` | Sessions de caisse (**sans opérateur**) | ❌ |
| 10 | `cash_movements` | Mouvements espèces | ❌ |
| 11 | `advances` | Avances sur salaire | ❌ |
| 12 | `bonuses` | Primes | ❌ |
| 13 | `salary_payments` | Paiements de salaire (partiels) | ❌ |
| 14 | `products` | Produits, CUMP, seuils | ❌ |
| 15 | `stock_movements` | Mouvements de stock | ❌ |
| 16 | `budgets` | Objectifs et plafonds | ❌ |
| 17 | `correction_logs` | Journal des corrections financières | ❌ |
| 18 | `salon_users` | Comptes (rôle binaire) | ❌ (`email` UNIQUE global) |
| 19 | `sync_tombstones` | Suppressions propagées | ❌ |

**Tables manquantes pour la vision** : `tenants`, `tenant_members`, `plans`, `subscriptions`, `invoices`, `feature_flags`/`plan_features`, `clients`, `appointments`, `client_loyalty`, `gift_cards`, `promo_codes`, `suppliers`, `purchase_orders`, `staff_shifts`, `attendance`, `notifications`, `audit_events`, `platform_admins`, `support_tickets`.

### 2.4 Surface API (7 routes)

| Route | Méthode | Authentification | Autorisation par rôle |
|---|---|---|---|
| `/api/health` | GET | publique | — (expose `databaseConfigured`, `pinRequired`) |
| `/api/auth/status` | GET | publique | — (indique si des comptes existent) |
| `/api/auth/register` | POST | publique (ou Gérant / PIN) | création de Gérant possible |
| `/api/auth/login` | POST | publique | — |
| `/api/sync/verify` | POST | jeton **ou** `SALON_SYNC_PIN` | ❌ aucune |
| `/api/sync/pull` | GET | jeton **ou** PIN | ❌ aucune (un Caissier lit tout) |
| `/api/sync` | POST | jeton **ou** PIN | ❌ aucune (un Caissier écrit tout) |

### 2.5 Modules fonctionnels existants (11 rubriques du README)

| Module | Lignes | Forces constatées | Limites constatées |
|---|---|---|---|
| Tableau de bord | 1 262 | KPI vs période précédente, alertes proactives, opérations cliquables, *deep-links* | Recharts dans le chunk principal (414 kB) ; alertes recalculées sur tout l'état |
| Caisse | 1 002 | sessions, billetage FCFA, écarts, corrections traçables, rapport A4 | **Session non rattachée à un utilisateur** → aucune responsabilité par caissier |
| Recettes | 1 022 | ticket multi-lignes, paiements mixtes, consommables, reçus séquentiels | **Pas de client**, pas d'avoir/remboursement, pas de TVA/facture |
| Dépenses | 1 428 | charges récurrentes 1-clic, pont stock, filtres, CSV | « Justificatif » = **chaîne de caractères** seulement (aucun fichier stocké) |
| Prestations | 1 775 | 3 modes de configuration, variantes, consommables, commissions, « Encaisser » 1 clic | Fichier le plus volumineux du dépôt (dette de découpage) |
| Personnel | 892 | 3 bases de commission, performance par employé | Aucun planning, aucune présence/absence, aucun objectif |
| Paie | 1 479 | avances, primes, acomptes, bulletins imprimables | Pas de cotisations sociales (CNPS/ITS), pas de congés |
| Inventaire | 1 272 | CUMP entier FCFA, seuils, mouvements, CSV | Pas de fournisseurs/BC, pas d'inventaire physique, pas de code-barres |
| Rapports | 1 124 | 8 états, rapprochement par mode de paiement, audit avant/après, CSV/print | Pas d'export PDF natif, pas de rapports planifiés |
| Budget | 617 | objectifs, pré-alerte 85 %, *run-rate*, reconduction 1 clic | Pas de budget par employé/agence |
| Paramètres | 1 280 | identité, thème, reçus, catégories, Cloud Neon, sauvegarde/restauration | **Aucune administration des comptes** (liste, désactivation, changement de rôle) malgré les méthodes dépôt existantes |

### 2.6 Ce que le produit fait déjà très bien (à préserver absolument)

- **Monnaie entière XOF** de bout en bout, sans flottants : excellent choix pour le marché visé.
- **Séparation espèces / Mobile Money** et rapprochement par mode de paiement.
- **CUMP recalculé** à chaque entrée fournisseur, en entiers.
- **Idempotence comptable** : ponts Dépendes ↔ Stock ↔ Paie ↔ Caisse (pas de double comptage).
- **Tombstones persistants** IndexedDB **et** PostgreSQL (14 entités) : mécanisme rare et précieux pour l'*offline-first*.
- **Aucune donnée fictive résiduelle** après purge (post-correctif) : contrat d'hygiène réellement implémenté.
- **Codes d'erreur API explicites** (`MANAGER_APPROVAL_REQUIRED`, `NETWORK_UNREACHABLE`…) et messages en français orientés utilisateur.

---

## 3. Conformité aux règles permanentes (`AGENTS.md`)

| Règle | Verdict avant audit | Verdict après correctif | Détail |
|---|---|---|---|
| **§1 — Zéro donnée fictive** | ❌ **Violée** | ✅ **Conforme** | 38 prestations + 5 catégories injectées automatiquement. Corrigé. Restent 12 composants de démonstration (`src/components/patterns/*`) contenant des données fictives (ex. `c-table-10.tsx:14` « Vercel Pro / GitHub Enterprise »), **non utilisés par l'application** et référencés uniquement par les tests : à déplacer hors `src/` ou à supprimer (P3). |
| **§2 — Purge persistante** | ✅ Conforme | ✅ Conforme | `mockPurge.ts` + tombstones IndexedDB + `sync_tombstones` (14 entités) + `dataHygieneVersion`. La purge est déclenchée à l'ouverture Dexie v4, à l'inscription, à la connexion, à l'import et à la synchro. |
| **§3 — Zéro secret codé en dur** | ⚠️ **Conforme avec réserves** | ⚠️ **Conforme avec réserves** | Aucun PIN/mot de passe en dur ; `.env.example` vierge ; `.salon-auth-secret` ignoré par Git. **Réserves** : (a) `getSigningSecret()` accepte `SALON_SYNC_PIN` comme clé HMAC — un code humain partagé devient secret cryptographique ; (b) en environnement *serverless* en lecture seule, le secret est **régénéré aléatoirement à chaque instance** (`authEngine.ts:24-49`) → déconnexions imprévisibles et jetons 30 jours inopérants si `SALON_AUTH_SECRET` n'est pas défini. **À rendre obligatoire en production.** |
| **§4 — Validation obligatoire** | ❌ Non satisfaite (3 tests rouges) | ✅ **Satisfaite** | `lint` 0, `test` 49/49, `build` OK. Aucun workflow CI ne l'automatise (voir §7.2). |

---

## 4. Analyse directive par directive d'`IMPLEMENTATIONS.md`

### 4.1 §1 — Les fondations d'un véritable SaaS multi-tenant

#### A. Multi-salons et multi-entreprises

| Attendu | État | Preuve / écart |
|---|---|---|
| Identité de tenant dans les données | ❌ | Aucune colonne `tenant_id` dans les 19 tables (`db/schema.sql`) |
| Espace indépendant par entreprise | ❌ | `salon_info.id` forcé à `'salon-main'` (`server/syncEngine.ts:366`) ; IndexedDB `SalonProLocalDB` unique (`database.ts:51`) |
| Plusieurs établissements par propriétaire | ❌ | Aucun modèle `organization`/`agency` |
| Isolation stricte côté serveur | ❌ | Toutes les requêtes sont non filtrées (`SELECT ... FROM revenues`) |

**Effort pour combler** : 8–12 j-h (schéma + RLS + scoping de toutes les requêtes + migration des données existantes + stratégie Dexie par tenant + tests).

#### B. Gestion avancée des utilisateurs (RBAC)

| Attendu | État | Écart |
|---|---|---|
| 7 rôles (propriétaire, admin, gérant, caissier, coiffeur, réceptionniste, comptable) | ❌ | `UserRole = 'manager' \| 'cashier'` (`models/index.ts:380`) |
| Permissions configurables | ❌ | Matrice figée dans le routeur |
| Application côté serveur | ❌ | `/api/sync*` ne teste que l'existence d'un jeton |
| Journal des opérations | ⚠️ | `correction_logs` couvre les corrections financières uniquement, pas les actions d'administration/sécurité |
| Gestion des comptes dans l'UI | ❌ | Inscription possible, mais **aucun écran** de liste/désactivation/réinitialisation |

**Effort** : 6–9 j-h (matrice de permissions + middleware + gestion des comptes + journal d'audit).

#### C. Isolation et sécurité des données

| Attendu | État | Commentaire |
|---|---|---|
| Politiques RLS PostgreSQL | ❌ | Zéro `ENABLE ROW LEVEL SECURITY`, zéro `CREATE POLICY` |
| Contrôle serveur (ne jamais faire confiance au `tenantId` navigateur) | ❌ | Pire : le serveur accepte même le **rôle** et le **hash de mot de passe** du navigateur (§6.1) |
| Journalisation des opérations | ⚠️ | Corrections financières oui ; authentification, rôles, exports, restaurations non |
| Sauvegardes automatiques | ❌ | Export JSON manuel + rappel après 7 jours (`buildDashboardAlerts`) ; aucun cron, aucune rétention, aucun test de restauration |
| Chiffrement au repos côté client | ❌ | IndexedDB en clair (y compris les hashes PBKDF2) |

**Effort** : 10–14 j-h (RLS + rotation de rôle PostgreSQL + audit append-only + sauvegardes planifiées + restauration testée).

#### D. Abonnements SaaS

| Attendu | État |
|---|---|
| Essai gratuit, Starter/Pro/Business, facturation récurrente | ❌ (aucune table, aucun code, aucun écran) |
| Limitations selon le forfait | ❌ |
| *Feature flags* | ❌ |
| Portail de facturation / webhooks | ❌ |

**Effort** : 10–15 j-h pour un socle (plans, entitlements, quotas, essai, états d'abonnement, écran de facturation ; l'intégration d'un PSP local — Wave Business, CinetPay, PayDunya — est à ajouter).

#### E. Point technique soulevé par le document

> « L'architecture actuelle utilise Dexie/IndexedDB et Neon PostgreSQL avec synchronisation. […] Il ne faut jamais faire confiance à un simple `tenantId` transmis par le navigateur. »

Le document vise juste : c'est **exactement** la faiblesse actuelle. Le futur jeton doit porter le tenant (`tid`) **signé**, et le serveur doit ouvrir chaque transaction avec `SET LOCAL app.tenant_id = <tid du jeton>`, jamais avec une valeur du corps de requête.

### 4.2 §2 — Innovations d'expérience utilisateur (A → F)

| Bloc | État | Existant | Manquant (détail) |
|---|---|---|---|
| **A. Agenda et réservation intelligente** | **0 %** | Rien | Calendrier jour/semaine/mois, réservation par employé **et par cabine**, disponibilités, réservation en ligne, rappels WhatsApp/SMS, gestion retards/absences |
| **B. CRM et fidélisation** | **5 %** | Champ `clientName` libre (`RevenueEntry`), notes libres | Fiche client, historique consolidé, préférences, anniversaires, points, cartes d'abonnement, bons cadeaux, codes promo |
| **C. Intelligence commerciale** | **70 %** | CA par période, rentabilité par prestation, performance employé, prestations les plus vendues, prévisions *run-rate*, alertes budget/stock/caisse | « Clients les plus fidèles » (impossible sans client), alertes de **baisse d'activité**, prévisions par employé/agence |
| **D. Stock et approvisionnement** | **60 %** | Consommables/revente/mixtes, déduction auto au ticket, seuils, CUMP, mouvements, valorisation | Fournisseurs (texte libre seulement), bons de commande, historique d'achats structuré, encours fournisseurs |
| **E. Gestion avancée du personnel** | **55 %** | Commissions (3 bases), primes, avances, acomptes, bulletins, classement de performance | Planning, présences/absences, objectifs individuels, primes/avances automatisées, bulletins légaux |
| **F. Communication WhatsApp** | **0 %** | Aucun | Confirmation, rappel, message post-prestation, relance inactifs, campagnes, envoi de reçus |

**Effort Phase 2 complète** : 30–45 j-h, dont 8–12 j-h pour l'agenda seul et 5–8 j-h pour la couche notifications (coût variable WhatsApp Business API à prévoir).

### 4.3 §3 — Les différenciateurs

| # | Différenciateur | État | Commentaire d'architecture |
|---|---|---|---|
| 1 | **SALON AI** (questions en langage naturel) | **0 %** | Faisable sans LLM au départ : les calculs existent déjà (`finance.ts`, 18 fonctions). Étape 1 = assistant à base d'intentions déterministes (« bénéfice cette semaine », « employé le plus vendeur ») ; étape 2 = LLM contraint à des requêtes SQL/agrégats validés, **jamais** d'accès libre aux données. |
| 2 | **Mini-site par salon** | **0 %** | Nécessite : route publique `/salon/:slug`, données publiques séparées (logo, photos, prestations, équipe, avis), réservation sans compte, SEO. Bloqué par l'absence de tenant. |
| 3 | **Portefeuille client numérique (QR)** | **0 %** | Dépend du CRM + d'un identifiant public non devinable ; le QR doit contenir un jeton opaque, pas l'ID interne. |
| 4 | **Paiements et caisse avancés** | **40 %** | Wave/OM/MTN existent comme **modes de paiement manuels**, avec rapprochement interne et partage d'un ticket. Manquent : encaissement réel via API, statuts de transaction, réconciliation automatique, paiements mixtes multi-opérateurs. |
| 5 | **Multi-agences** | **0 %** | Nécessite `organization` → `tenants` (1..n) + consolidation ; c'est la fonctionnalité la plus rentable de l'offre Business (19 900 FCFA). |

### 4.4 §4 — Le portail d'administration éditeur

| Module attendu | État | Prérequis bloquant |
|---|---|---|
| Entreprises (création, activation, suspension) | ❌ | Table `tenants` + rôle plateforme |
| Abonnements (forfaits, renouvellements, paiements) | ❌ | Tables `plans`, `subscriptions`, `invoices` |
| Utilisateurs (comptes, rôles, accès) | ❌ | RBAC étendu + membership |
| Revenus SaaS | ❌ | Facturation |
| Support (tickets) | ❌ | Table `support_tickets` |
| Statistiques (salons actifs, croissance, usage) | ❌ | Télémétrie d'usage |
| Configuration (paramètres globaux, *feature flags*) | ❌ | Table `feature_flags` |
| Audit (actions administratives) | ❌ | Table `platform_audit_log` append-only |

**Effort Phase 5** : 15–20 j-h, **après** la Phase 1 (dépendance dure).

### 4.5 §5 — Offres commerciales

Aucune des offres (Découverte / Professional 9 900 / Business 19 900 / Enterprise sur devis) n'est aujourd'hui **applicable techniquement** : il n'existe ni plan, ni quota, ni *feature flag*, ni essai, ni blocage.

Recommandations de chiffrage et de *packaging* :

- **Vérifier la marge** : à 9 900 FCFA/mois (≈ 15 €), les coûts variables (Neon, Vercel, WhatsApp Business ≈ 0,02–0,06 USD par conversation, frais PSP 1–2 %) restent absorbables, mais **les notifications WhatsApp doivent être un crédit payant ou une option**, sinon l'offre Professional devient déficitaire pour les salons à fort volume.
- **Ajouter des leviers** : agence supplémentaire (+3 000–5 000 FCFA), pack WhatsApp, sauvegarde externalisée, formation/installation (one-shot).
- **Facturation** : prévoir annuel prépayé (-15 à -20 %) pour financer l'acquisition, très courant en Afrique de l'Ouest.
- **Essai** : 14 jours sur Professional (pas sur Découverte), avec limitation à 1 établissement et 2 utilisateurs — cohérent avec les quotas à implémenter.

### 4.6 §6 — Feuille de route : lecture critique

| Phase | Ce qui est fait | Ce qui manque | Dépendance |
|---|---|---|---|
| **1 — Fondations** | auth locale + cloud, 2 rôles, sauvegarde/restauration JSON, purge, journal des corrections | tenant, RLS, RBAC étendu, abonnements, audit sécurité, sauvegarde auto, révocation | — |
| **2 — Expérience client** | — | agenda, réservation, CRM, fidélité, notifications | **dépend de la Phase 1** (isolation + RBAC) |
| **3 — Gestion pro** | caisse, recettes, dépenses, stock, paie, rapports, paiements multiples | fournisseurs/BC, planning, multi-agences, API paiements | dépend de la Phase 1 (multi-agences) |
| **4 — Innovation** | *run-rate*, alertes | AI, mini-site, portail client, automatisations | dépend des Phases 1–3 |
| **5 — Éditeur** | — | tout | dépend de la Phase 1 (tenants + abonnements) |

**Critique de l'ordonnancement proposé** : il est bon, mais il omet deux chantiers **transverses et bloquants** qui doivent précéder ou accompagner la Phase 1 :

1. **Migrations de schéma** : le schéma n'est créé que par `CREATE TABLE IF NOT EXISTS` (`neonSchema.ts`). Impossible d'ajouter `tenant_id` proprement sans système de migration versionnée (et sans risque de divergence entre `db/schema.sql` et `neonSchema.ts`).
2. **Service Worker / PWA** : le manifeste existe (`public/manifest.webmanifest`) mais **aucun service worker n'est enregistré** (aucune occurrence de `serviceWorker`/`workbox`). Le mode « hors-ligne » ne couvre donc que les **données**, pas le **chargement de l'application** : après un rafraîchissement sans réseau, l'écran est blanc. Pour un produit vendu « hybride hors-ligne » en Afrique de l'Ouest, c'est un défaut produit majeur (2–3 j-h de correctif).

### 4.7 §7 — Les quatre choix stratégiques : recommandation

| Question | Recommandation | Justification |
|---|---|---|
| **1. Quels établissements ?** | **Tous les professionnels de la beauté** (coiffure, barber, esthétique, onglerie, spa). | Le socle est déjà générique ; seuls les libellés métier sont « barber ». Prévoir un **vocabulaire configurable** par tenant («prestation / soin», «cabine / fauteuil») plutôt que dupliquer le produit. Le nom « SALON PRO » est déjà adapté. |
| **2. Quelle architecture ?** | **Hybride, hors-ligne d'abord** (option 3 du document). | C'est déjà l'ADN du produit (Dexie + tombstones + LWW) et la réalité réseau du marché. Mais il faut la **compléter** : service worker, synchronisation delta, résolution de conflits explicite, indicateurs d'état de synchronisation par entité. |
| **3. Quel modèle commercial ?** | **Freemium + abonnements + options payantes** (option 3). | Le coût marginal d'un petit salon est faible ; le freemium est le meilleur canal d'acquisition dans un marché fragmenté. Les options (WhatsApp, multi-agences, IA) financent la marge. |
| **4. Priorité du prochain chantier ?** | **Sécuriser et transformer l'architecture en véritable SaaS multi-tenant** (option 1), avec un **préalable de 3 correctifs de sécurité** (§6.1, P0-1 à P0-3). | Toute fonctionnalité ajoutée aujourd'hui (agenda, CRM) serait à migrer ensuite. La monétisation (abonnements) est impossible sans tenants. L'ordre proposé par le document est validé. |

---

## 5. Architecture cible multi-tenant (proposition concrète)

### 5.1 Modèle de tenancy : organisation → établissements

Le document exige à la fois « multi-salons », « multi-entreprises » et « multi-agences ». Le modèle le plus souple, sans surcoût au démarrage, est **deux niveaux** :

```
organizations (propriétaire, plan, facturation)
   └── tenants (salon / agence : identité, adresse, réglages, données)
          └── memberships (utilisateur ↔ tenant, rôle)
users (identité globale, e-mail, mot de passe)
```

- Un propriétaire mono-salon : 1 organisation, 1 tenant.
- Une chaîne : 1 organisation, N tenants, consolidation au niveau organisation.
- Un salarié peut appartenir à 2 tenants avec des rôles différents.

```sql
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug          text NOT NULL UNIQUE,          -- salonpro.app/salon/<slug>
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'trial', -- trial|active|suspended|cancelled
  timezone      text NOT NULL DEFAULT 'Africa/Abidjan',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,        -- global, plus de collision inter-tenant
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE app_role AS ENUM
  ('owner','admin','manager','cashier','stylist','receptionist','accountant');

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       app_role NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id)
);
```

### 5.2 Isolation par RLS (et non par `WHERE` applicatif)

Appliquer à **chacune** des 19 tables métier :

```sql
ALTER TABLE revenues
  ADD COLUMN tenant_id uuid NOT NULL REFERENCES tenants(id),
  DROP CONSTRAINT revenues_pkey,
  ADD PRIMARY KEY (tenant_id, id),
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at::timestamptz,
  ADD COLUMN server_seq bigint NOT NULL DEFAULT 0;

CREATE INDEX revenues_tenant_date_idx ON revenues (tenant_id, date DESC);

ALTER TABLE revenues ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenues FORCE ROW LEVEL SECURITY;   -- indispensable : le propriétaire de la table contourne sinon la RLS

CREATE POLICY tenant_isolation ON revenues
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Côté serveur, **une seule** porte d'entrée (jamais de valeur venant du corps de requête) :

```ts
await client.query('BEGIN');
await client.query("SELECT set_config('app.tenant_id', $1, true)", [session.tid]); // true = portée transaction
// … toutes les requêtes sont désormais filtrées par PostgreSQL
await client.query('COMMIT');
```

Points d'attention :

- L'utilisateur applicatif PostgreSQL doit être `NOSUPERUSER NOBYPASSRLS` et **ne pas être propriétaire** des tables (sinon `FORCE ROW LEVEL SECURITY` est obligatoire — inclus ci-dessus).
- Les migrations utilisent un rôle séparé.
- Le pool `pg` doit être configuré pour que `set_config(..., true)` ne « fuite » pas entre requêtes : la portée transactionnelle garantit la remise à zéro au COMMIT/ROLLBACK.
- Toute requête d'administration éditeur passe par un rôle distinct (`platform_admin`) avec des policies dédiées — jamais par le même chemin.

### 5.3 Jeton de session : du `s1` au `s2`

```ts
// Actuel (server/authEngine.ts:100)
{ uid, email, role, exp }              // 30 jours, aucun tenant, aucune révocation

// Cible
{
  sub: userId,
  tid: tenantId,        // tenant actif, signé
  org: organizationId,
  role: 'manager',      // rôle DANS ce tenant
  sid: sessionId,       // pour révocation ciblée
  iat, exp              // 15 min (access) + refresh 30 j en cookie HttpOnly
}
```

- **Access token court (10–15 min)** + **refresh token** rotatif ; table `sessions` pour révoquer (déconnexion, changement de rôle, suspension de tenant).
- Jeton en **cookie `HttpOnly; Secure; SameSite=Lax`** plutôt qu'en `localStorage` (l'actuel `AUTH_TOKEN_LOCAL_KEY` est exposé à toute XSS).
- `SALON_AUTH_SECRET` **obligatoire** en production (sinon le secret est régénéré à chaque instance serverless : `authEngine.ts:24-49`).
- Limitation de débit + verrouillage progressif sur `/api/auth/login` (absent aujourd'hui) ; 2FA TOTP pour les rôles `owner`/`admin`/plateforme.

### 5.4 Synchronisation : passer du « blob complet LWW » au **delta serveur-autoritaire**

| Aujourd'hui | Cible |
|---|---|
| Le client envoie **tout** l'état (19 tables) | Le client envoie seulement les entités modifiées depuis `lastCursor` |
| `updated_at` **fourni par le client** | `updated_at`/`server_seq` **attribués par le serveur** (horloge de confiance) |
| Conflit = « la date la plus grande gagne » | Conflit par entité : fusion par champ pour `settings`, arbitrage métier pour l'argent (jamais d'écrasement silencieux d'une recette) |
| Pas de pagination, plafond 15 Mo | Pagination par curseur (`?since=seq&limit=500`) |
| Tombstones non scopés | Tombstones par tenant, purge après 90 jours |

Effet attendu : synchronisation **O(changements)** au lieu de **O(données)**, ce qui est indispensable dès 20–30 salons actifs.

### 5.5 Côté IndexedDB (Dexie v5)

- Une base **par tenant** : `SalonProLocalDB__<tenantId>` (isolation simple, purge à la déconnexion, pas de fuite entre comptes sur un poste partagé — cas réel en salon).
- Ajout des index composés : `revenues: 'id, [tenantId+date], [tenantId+employeeId], …'` si l'on préfère une base unique.
- Table `sync_meta` (curseur, dernier succès, entités en conflit) et `outbox` (file d'attente d'écritures hors-ligne).
- **Chiffrement au repos** : au minimum ne plus stocker les hashes de mots de passe en clair dans IndexedDB ; utiliser un vérificateur local dérivé (PBKDF2 avec sel propre à l'appareil) pour la connexion hors-ligne.

### 5.6 Abonnements, quotas et *feature flags*

```sql
CREATE TABLE plans (
  code text PRIMARY KEY,            -- discovery|professional|business|enterprise
  label text NOT NULL,
  price_xof integer NOT NULL,
  max_tenants integer,              -- NULL = illimité
  max_users integer,
  features jsonb NOT NULL           -- {"agenda":true,"crm":true,"ai":false,...}
);

CREATE TABLE subscriptions (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  plan_code text NOT NULL REFERENCES plans(code),
  status text NOT NULL,             -- trialing|active|past_due|suspended
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  provider text,                    -- wave|cinetpay|paydunya|stripe
  provider_ref text
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, amount_xof integer NOT NULL,
  status text NOT NULL, issued_at timestamptz, paid_at timestamptz, lines jsonb
);
```

Contrôle d'accès fonctionnel **côté serveur** (`requireFeature('agenda')`) doublé d'un masquage UI — jamais l'inverse.

### 5.7 Migrations et observabilité (prérequis oubliés par le document)

- **Migrations versionnées** (`node-pg-migrate` ou SQL numéroté appliqué par une table `schema_migrations`), avec `db/schema.sql` **généré** depuis les migrations pour supprimer la triple source de vérité.
- **Journal d'audit append-only** : `audit_events(tenant_id, actor_id, action, entity, entity_id, before, after, ip, user_agent, at)` écrit **côté serveur** ; conserver `correction_logs` pour l'usage métier.
- **Observabilité** : journalisation structurée des requêtes API (durée, code, `tenant_id`, `user_id`), suivi d'erreurs, métriques de synchronisation (volume, échecs, conflits), alerte sur `/api/health`.

---

## 6. Registre des vulnérabilités et risques

### 6.1 Sécurité — classement par sévérité

| ID | Sévérité | Vulnérabilité | Scénario d'exploitation | Preuve | Correctif | Effort |
|---|---|---|---|---|---|---|
| **S1** | 🔴 **Critique** | Escalade de privilèges via `/api/sync` | Un Caissier authentifié envoie un payload `SALON_PRO_BACKUP_V1` contenant `users: [{ id: <son id>, role: 'manager', updatedAt: <futur>, passwordHash: <le sien> }]` → il devient Gérant (ou remplace le mot de passe du Gérant). | `models/index.ts:416` ; `syncEngine.ts:802-830` ; aucune vérification de rôle sur la route | **Retirer `users` du payload de synchronisation** ; gestion des comptes via des routes dédiées protégées ; ignorer `role`/`passwordHash` entrants ; journaliser. | 3–5 j |
| **S2** | 🔴 **Critique** | Absence d'isolation multi-tenant | Deux salons configurés sur le même `DATABASE_URL` lisent et écrasent mutuellement leurs données ; le premier « sync » écrase le second. | `db/schema.sql` (0 `tenant_id`, 0 policy) ; `syncEngine.ts:366` | §5.1–5.2 (RLS + `tenant_id` signé) | 8–12 j |
| **S3** | 🟠 Élevée | Autorisation serveur absente | Un jeton Caissier télécharge toute la paie, les salaires, les paramètres (`/api/sync/pull`) et peut pousser n'importe quelle écriture. | `apiHandler.ts:283-330` | Middleware d'autorisation par route + par entité (matrice RBAC) | 3 j |
| **S4** | 🟠 Élevée | Sessions non révocables, 30 jours, `localStorage` | Vol de jeton (XSS, poste partagé en salon) → accès total pendant 30 jours ; aucune déconnexion serveur possible. | `authEngine.ts:20` ; `AuthProvider.tsx:24-95` | Access court + refresh rotatif + table `sessions` + cookie HttpOnly + révocation | 4 j |
| **S5** | 🟠 Élevée | *Last-Write-Wins* sur horodatage client | Un poste avec une horloge en avance (ou un payload forgé) gagne **définitivement** tous les conflits ; une recette peut être écrasée par une version obsolète. | `syncEngine.ts` (`WHERE EXCLUDED.updated_at > table.updated_at`, `updated_at TEXT`) | Horodatage serveur + `server_seq` + stratégie de conflit par entité | 4–6 j |
| **S6** | 🟡 Moyenne | Bruteforce / inscription non limitées | `/api/auth/login` sans limitation ni verrouillage ; `/api/auth/register` public peut créer le premier Gérant ; PBKDF2 100 k (recommandé 600 k ou Argon2id) ; mot de passe minimum 6 caractères. | `apiHandler.ts:204-280` ; `authEngine.ts:18,230` | Rate limit par IP/compte, backoff, politique de mot de passe, vérification e-mail | 2–3 j |
| **S7** | 🟡 Moyenne | Secret de signature non persistant en serverless | Sans `SALON_AUTH_SECRET`, chaque instance signe avec un secret aléatoire différent → sessions invalidées aléatoirement ; en multi-instance, boucle de déconnexions. | `authEngine.ts:24-49` | Rendre la variable **obligatoire** au démarrage (échec explicite) | 0,5 j |
| **S8** | 🟡 Moyenne | Absence de migrations de schéma | `CREATE TABLE IF NOT EXISTS` uniquement : impossible d'altérer, risque de divergence des trois définitions. | `neonSchema.ts` ; `db/schema.sql` | Migrations versionnées (§5.7) | 2–3 j |
| **S9** | 🟡 Moyenne | Hashes de mots de passe dans IndexedDB | Tout utilisateur du poste (ou un script) peut extraire les hashes et les casser hors-ligne ; aucune limite de tentatives locale. | `salonRepositories.ts` (users), `AuthProvider` | Vérificateur local par appareil + sel appareil + limitation locale | 3 j |
| **S10** | 🟢 Faible | En-têtes de sécurité absents | Aucune CSP, HSTS, `X-Frame-Options` (Vercel peut les fournir) ; pas de `Referrer-Policy`. | `vercel.json`, `index.html` | Ajouter les en-têtes dans `vercel.json` | 0,5 j |
| **S11** | 🟢 Faible | Fuites d'information mineures | `/api/health` révèle `pinRequired` ; `/api/auth/status` révèle l'existence de comptes ; messages d'erreur SQL remontés. | `apiHandler.ts:155-170,186` | Messages génériques + journalisation interne | 0,5 j |

> **Bon point** : aucun `dangerouslySetInnerHTML`, `innerHTML` ni `eval` dans le code (vérifié) — la surface XSS se limite donc au stockage de jetons (S4).

### 6.2 Risques produit, données et exploitation

| Risque | Impact | Probabilité | Mitigation |
|---|---|---|---|
| **Mode hors-ligne incomplet** (pas de service worker) | Écran blanc après rechargement sans réseau → perte de confiance sur le terrain | Élevée | `vite-plugin-pwa` + pré-cache app shell + écran « hors-ligne prêt » + test aérien |
| **Absence de sauvegarde automatique** | Perte définitive en cas de panne disque/navigateur effacé | Moyenne | Export planifié (serveur) + `pg_dump` quotidien + test de restauration trimestriel |
| **Conflits de synchronisation silencieux** | Écrasement d'écritures comptables | Moyenne | Journal de conflits visible + arbitrage manuel + horodatage serveur (S5) |
| **Dépendance mono-fournisseur Neon** | Indisponibilité prolongée | Faible | Le local-first couvre la continuité ; prévoir un export automatique |
| **Conformité données personnelles** (loi ivoirienne n° 2013-450 / ARTCI, RGPD si clients européens) | Sanction, réputation | Moyenne | Registre de traitement, durée de conservation, droit à l'effacement, hébergement et sous-traitants documentés — à traiter avec le CRM (Phase 2) |
| **Paiements Mobile Money non intégrés** | Rapprochement manuel, erreurs | Élevée (marché) | Intégrer Wave Business / CinetPay et réconcilier par *webhook* idempotent |
| **Volonté de tout construire en même temps** | Retard, dette, modèle de données instable | Élevée | Respecter strictement l'ordre Phase 1 → 2 → 5 |

---

## 7. Qualité d'ingénierie et dette technique

### 7.1 Points forts

- **TypeScript strict** partout, domaine modélisé (types métier riches), calculs financiers **purs et testables** (`src/domain/calculations/finance.ts`, 18 fonctions), séparés de l'UI : très bon socle pour la suite.
- **Couche dépôt** centralisée (`SalonRepositoryHub`, 3 608 lignes) avec transactions Dexie multi-tables atomiques.
- **Tests** : 49 tests couvrant calculs, flux métier, auth/RBAC UI, synchronisation, composants ; `fake-indexeddb` bien utilisé ; tests serveur avec faux pool.
- **Hygiène** : messages d'erreur typés, purge documentée, aucun `any` visible dans les couches critiques, lint sans avertissement.
- **UX** : cohérence de design system, accessibilité de base (`aria`, labels), impression dédiée 80 mm / A5.

### 7.2 Dette technique et lacunes d'ingénierie

| Sujet | Constat | Recommandation | Effort |
|---|---|---|---|
| **CI/CD** | Aucun `.github/workflows` : les règles d'`AGENTS.md` §4 ne sont pas automatisées | Workflow `lint + test + build` sur chaque PR, cache npm, blocage du merge | 0,5 j |
| **Couverture** | Aucun *provider* de couverture, aucun seuil | `@vitest/coverage-v8`, seuil 70 % sur `src/domain` et `server` | 1 j |
| **Tests manquants critiques** | Aucun test d'autorisation serveur (Caissier → manager), aucun test RLS, aucun E2E | Ajouter tests d'escalade (S1/S3), tests de contrat API, Playwright sur 3 parcours (encaisser, clôturer, synchroniser) | 4–6 j |
| **Monolithes UI** | 6 fichiers > 1 000 lignes (Prestations 1 775, Paie 1 479, Dépenses 1 428) | Découper par onglet/composant, extraire les formulaires | 5–8 j |
| **Bundle** | 1 314 kB JS (dont Recharts 414 kB dans le tableau de bord, chunk principal 540 kB) | Chargement différé des graphiques, `manualChunks`, budget 250 kB/route | 2 j |
| **Triple schéma** | `schema.sql` = `neonSchema.ts` = Dexie (maintenus à la main) | Générer `schema.sql` depuis les migrations ; test de parité automatique | 1 j |
| **Traçabilité utilisateur** | `CashSession` n'a pas d'opérateur ; les écritures n'ont pas d'auteur | Ajouter `openedByUserId`, `createdBy` sur recettes/dépenses/corrections | 2 j |
| **Attachements** | « Justificatif » = texte | Stockage objet (Vercel Blob / S3) + métadonnées, lien signé | 3 j |
| **Configuration Supabase inutilisée** | `supabase/config.toml` (projet `barbercut`), aucun dossier `migrations/`, `seed.sql` manquant alors que `db.seed.enabled = true` → `supabase db reset` échoue | Soit retirer ce socle, soit l'utiliser réellement (voir §9, décision D2) | 0,5 j |
| **Branding incohérent** | `salon-pro` (package), « Barbershop » (manifeste), `barbercut` (Supabase), « SALON PRO » (UI) | Unifier la marque et le vocabulaire dans les métadonnées | 0,5 j |
| **Composants de démonstration** | 12 `patterns/*` avec données fictives, utilisés uniquement par les tests | Déplacer dans `docs/` ou supprimer ; conserver les 18 composants `ui/` réellement utilisés | 1 j |
| **Observabilité** | Aucun log structuré, aucune remontée d'erreur | Journalisation JSON + suivi d'erreurs + métriques de sync | 2 j |

---

## 8. Backlog priorisé (avec dépendances et critères d'acceptation)

Estimations : **j-h**, 1 développeur senior + assistance IA. `P0` = bloquant sécurité/fondation · `P1` = monétisation/acquisition · `P2` = périmètre professionnel · `P3` = innovation.

### P0 — Sécuriser et fonder le multi-tenant (25–35 j-h)

| # | Chantier | Détail | Effort | Critère d'acceptation |
|---|---|---|---|---|
| **P0-0** | Hygiène des données | ✅ **Fait** : plus aucun catalogue pré-rempli ; tests verts | 0,5 | `npm test` 49/49 |
| **P0-1** | Retirer les comptes du payload de sync | Routes `POST /api/users`, `PATCH /api/users/:id` (rôles), hash serveur uniquement | 3–5 | Un Caissier ne peut plus modifier un rôle ni un mot de passe (test automatisé) |
| **P0-2** | `tenant_id` + RLS + `organizations`/`tenants`/`memberships` | Migration des 19 tables, `FORCE RLS`, rôle applicatif restreint, backfill mono-tenant | 8–12 | Une requête sans `app.tenant_id` renvoie 0 ligne ; deux tenants de test ne se voient jamais |
| **P0-3** | Jeton `s2` + autorisation serveur par rôle | `tid`, `sid`, access court + refresh, middleware `requireRole` par route | 4–6 | Un Caissier reçoit 403 sur paie/paramètres côté API |
| **P0-4** | Migrations versionnées | `schema_migrations`, remplacement de `CREATE TABLE IF NOT EXISTS`, génération de `db/schema.sql` | 2–3 | `npm run db:migrate` idempotent sur base vierge et existante |
| **P0-5** | Durcissement auth | Rate limit login, politique mot de passe, `SALON_AUTH_SECRET` obligatoire, révocation de session, en-têtes de sécurité | 3–4 | 10 tentatives échouées → verrouillage temporaire ; déconnexion invalide le jeton |
| **P0-6** | Synchronisation delta serveur-autoritaire | `server_seq`, curseur, pagination, horodatage serveur, journal de conflits | 5–7 | Sync de 10 000 écritures < 1 s côté serveur, payload < 100 kB par appel |
| **P0-7** | PWA réellement hors-ligne | Service worker, pré-cache, écran de mise à jour | 2–3 | Rechargement à froid sans réseau → application utilisable |
| **P0-8** | CI + couverture + tests d'escalade | Workflow, seuils, tests d'autorisation | 5–6 | Pipeline bloquant sur PR ; couverture `domain`/`server` ≥ 70 % |

### P1 — Monétiser et acquérir (30–45 j-h)

| # | Chantier | Effort | Dépendance |
|---|---|---|---|
| **P1-1** | Plans, quotas, essai, *feature flags*, écran d'abonnement | 10–12 | P0-2 |
| **P1-2** | Intégration PSP (Wave/CinetPay/PayDunya) + webhooks idempotents + factures | 6–10 | P1-1 |
| **P1-3** | Console super-administrateur (tenants, abonnements, usage, support, audit) | 8–12 | P0-2, P1-1 |
| **P1-4** | Gestion des comptes et des rôles dans les Paramètres | 3–4 | P0-3 |
| **P1-5** | Sauvegardes automatiques + restauration testée | 3–4 | P0-4 |
| **P1-6** | Modèle `clients` + fiche + historique + fidélité de base | 6–8 | P0-2 |
| **P1-7** | Agenda + rendez-vous (jour/semaine/mois, employé, cabine) | 8–10 | P1-6 |
| **P1-8** | Notifications WhatsApp/SMS (confirmation, rappel, reçu) | 5–8 | P1-7 |

### P2 — Gestion professionnelle (20–30 j-h)

| # | Chantier | Effort |
|---|---|---|
| **P2-1** | Fournisseurs, bons de commande, historique d'achats, encours | 8–10 |
| **P2-2** | Planning du personnel, présences/absences, objectifs | 6–8 |
| **P2-3** | Multi-agences : consolidation, comparaison, équipes par établissement | 8–10 |
| **P2-4** | Justificatifs (stockage objet), export PDF natif, rapports planifiés | 5–7 |

### P3 — Innovation (25–40 j-h)

| # | Chantier | Effort |
|---|---|---|
| **P3-1** | Mini-site public par salon (slug, catalogue, équipe, réservation, avis) | 10–14 |
| **P3-2** | Portefeuille client QR + bons cadeaux + codes promo | 6–8 |
| **P3-3** | SALON AI (intentions déterministes puis LLM contraint) | 8–12 |
| **P3-4** | Automatisations (relance inactifs, anniversaires, alertes de baisse) | 4–6 |

**Chemin critique** : P0-2 → P0-3 → P1-1 → P1-3. Tout le reste peut être parallélisé.

---

## 9. Feuille de route opérationnelle proposée (90 jours)

### Sprint 1 — « On ne peut plus se faire prendre » (2 semaines)

- P0-0 (fait), **P0-1**, P0-5, P0-8.
- Livrables : plus d'escalade via sync, login limité, secret obligatoire, CI verte sur chaque PR, tests d'autorisation.
- Critère de sortie : audit interne OK ; aucune route n'accepte un rôle venant du client.

### Sprint 2 — « Vrai multi-tenant » (3 semaines)

- P0-2, P0-4, P0-6, P0-7.
- Livrables : `organizations/tenants/memberships`, RLS sur 19 tables, migration des bases existantes, sync delta, PWA hors-ligne.
- Critère de sortie : deux salons de démonstration totalement isolés (test automatisé) ; rechargement hors-ligne fonctionnel.

### Sprint 3 — « Monétisable » (3 semaines)

- P1-1, P1-2, P1-3 (socle), P1-4, P1-5.
- Livrables : plans et quotas appliqués, essai 14 jours, paiement Mobile Money, console éditeur, gestion des comptes, sauvegardes automatiques.
- Critère de sortie : création d'un salon, souscription, suspension, réactivation de bout en bout.

### Sprints 4–6 — « Acquisition » (6 semaines)

- P1-6 → P1-8, puis P2-1/P2-2 en parallèle.
- Livrables : clients, agenda, réservation en ligne, rappels WhatsApp, fournisseurs, planning.

---

## 10. Décisions à valider

| # | Question | Recommandation |
|---|---|---|
| **D1** | Validez-vous le modèle **organisation → tenants** (multi-agences natif) plutôt qu'un simple `tenant_id` plat ? | Oui : coût initial +15 %, mais évite une seconde migration pour l'offre Business. |
| **D2** | **Neon + auth maison + RLS** (statu quo renforcé) ou **migration vers Supabase** (Auth + RLS + Storage + Realtime) ? | Rester sur **Neon** à court terme (déjà intégré, aucun verrou) et appliquer la RLS ; réévaluer Supabase quand le mini-site et le portail client arriveront (besoins Storage/Realtime). Le `supabase/config.toml` présent doit sinon être supprimé ou complété. |
| **D3** | Que faire des **38 prestations « Fresh Barber »** déjà présentes dans les bases existantes ? | Les **conserver** (grille tarifaire réelle de l'opérateur) et proposer une action « Importer la grille » ; ne pas purger automatiquement. Purge optionnelle fournie en annexe E. |
| **D4** | Faut-il **conserver** la synchronisation par état complet pour les très petites installations (mode simplifié) ? | Non : un seul chemin de synchronisation (delta) est plus sûr et moins coûteux à maintenir. |
| **D5** | Priorité commerciale : **abonnements + console éditeur** (P1) ou **agenda + WhatsApp** (acquisition) ? | **Abonnements d'abord** : sans encaissement récurrent, l'acquisition ne finance pas le développement. L'agenda suit immédiatement. |

---

## 11. Suivi des correctifs — Sprints 1 à 4 (implémentés)

> Mise à jour du 30 octobre 2026, branche `arena/139c7e36-barber-shop`. Sprint 1 : périmètre P0-1 / P0-5 / P0-8 du backlog. Sprint 2 : P0-2 (isolation multi-tenant + RLS) et P0-4 (migrations versionnées). Sprint 3 : S4 (sessions révocables). Sprint 4 : P0-6 (synchronisation delta serveur-autoritaire).

### 11.1 Vulnérabilités traitées

| ID | Statut | Correctif livré |
|---|---|---|
| **S1** (critique) — escalade via `/api/sync` | ✅ **Corrigée** | `users` retiré de `buildCloudSyncEnvelope`, ignoré côté serveur (`stripUsersFromSyncPayload`), absent des payloads de pull et de la fusion locale. Routes dédiées `/api/users`, `/api/users/provision`, `PATCH /api/users/:id` réservées au Gérant, avec provisionnement en **création seule** (aucun écrasement de rôle ou de hash). |
| **S2** (critique) — aucun cloisonnement entre salons | ✅ **Corrigée** | `organizations` → `tenants` → données : `tenant_id` sur les 19 tables, RLS activée **et forcée** sur les 18 tables métier (politique `USING` + `WITH CHECK`), contexte posé par transaction (`set_config('app.tenant_id', …, true)`). Le salon provient du jeton signé (`tid`) ou du serveur, jamais de la requête. Voir §11.4. |
| **S3** (élevée) — aucune autorisation serveur | 🟡 **Partielle** | Autorisation serveur sur toute l'administration des comptes (401 sans session, 403 hors Gérant, rate limit par acteur). Depuis P0-6, les données ne sont plus écrites sous la dictée du client (ordre et contenu validés côté serveur, isolation par salon). Reste : autorisation **par entité métier** (qui peut modifier quoi) et garde de rôle sur les routes métier. |
| **S4** (élevée) — sessions non révocables | ✅ **Corrigée** | Table `sessions` (migration `003_sessions`), jeton d'accès signé de 15 min porteur du claim `sid`, jeton de rafraîchissement opaque haché en base, rotation à usage unique, détection de rejeu révoquant toute la famille, révocation immédiate à la déconnexion. Voir §11.6. |
| **S5** (élevée) — LWW sur horodatage client | ✅ **Corrigée** | Un client à jour (curseur) ne peut plus figer ni écraser une ligne par une horloge artificielle : le serveur applique les écritures **dans l'ordre d'arrivée** et attribue la révision. Les push « à l'aveugle » (sans curseur) restent filtrés par horodatage pour ne pas écraser de données récentes. Voir §11.7. |
| **S6** (moyenne) — bruteforce / politique faible | ✅ **Corrigée** | Rate limiting (5/identité + 30/IP sur 15 min, 10 inscriptions/heure), politique 8 caractères lettre + chiffre côté serveur **et** hors-ligne, buckets réinitialisés après une connexion réussie. |
| **S7** (moyenne) — secret non persistant en serverless | ✅ **Corrigée** | `SALON_AUTH_SECRET` obligatoire en production (`AUTH_SECRET_MISSING` explicite) ; repli local persistant conservé hors production. |
| **S8** (élevée) — aucun mécanisme de migration | ✅ **Corrigée** | `server/migrations.ts` : registre `schema_migrations`, migrations `001_baseline` / `002_multi_tenant`, exécution transactionnelle, idempotence testée. Voir §11.4. |
| **S10** (faible) — en-têtes de sécurité absents | ✅ **Corrigée** | `vercel.json` : CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ; `X-Content-Type-Options` sur toutes les réponses API. |
| **S11** (faible) — fuites d'information | 🟡 **Partielle** | `/api/health` et `/api/auth/status` conservés pour la compatibilité de l'UI (aucun secret exposé) ; à revoir avec la télémétrie (P1-3). |

### 11.2 Garde-fous supplémentaires livrés

- Impossible de retirer le rôle Gérant ou de désactiver le **dernier Gérant actif** (`LAST_MANAGER_REQUIRED`), ni de désactiver son propre compte.
- Les hashes de mots de passe ne sont **jamais** renvoyés par `GET /api/users` (vérifié par test).
- Toute opération d'administration est journalisée (`[audit] user.provision|user.update`) ; l'écriture en base (`audit_events`) reste au backlog P1-3.
- Intégration continue ajoutée (`.github/workflows/ci.yml`) : lint + tests + build sur chaque PR et sur `main`.

### 11.3 Validation

| Commande | Résultat |
|---|---|
| `npm run lint` | 0 erreur, 0 avertissement (111 fichiers) |
| `npm test` | **70/70** tests verts (14 fichiers, dont 12 tests de sécurité, 5 tests d'isolation multi-salon et 4 tests de migrations) |
| `npm run build` | OK |

Nouveaux tests (`src/test/securityHardening.test.ts`) couvrant : injection de comptes dans un payload de sync, absence de comptes dans l'enveloppe client, provisionnement en création seule, refus d'escalade, protection du dernier Gérant, hachage serveur, politique de mot de passe, blocage bruteforce et libération du compteur, secret obligatoire en production.

### 11.4 Sprint 2 — isolation multi-tenant & migrations (implémenté)

Objectif : rendre le modèle de données réellement multi-salon. Le salon d'appartenance n'est **jamais** lu dans une requête : il provient exclusivement du jeton de session signé (`tid`) ou, en dernier recours, de la configuration serveur (`SALON_DEFAULT_TENANT_ID`).

#### Modèle de tenancy (D1)

| Objet | Rôle |
|---|---|
| `organizations` | Entité de facturation (un cabinet comptable peut posséder plusieurs salons) |
| `tenants` | Un salon : `slug` unique (futur `salonpro.app/salon/<slug>`), fuseau `Africa/Abidjan`, statut `active` |
| `tenant_id` | Colonne ajoutée sur les **19** tables métier, `NOT NULL`, backfillée vers le salon par défaut, avec `DEFAULT current_setting('app.tenant_id', true)::uuid` |
| `salon_users` | Également porteur de `tenant_id`, mais **hors RLS** : l'authentification précède la résolution du salon. Unicité `(tenant_id, lower(email))` |

#### Isolation en base (RLS)

- `ENABLE` **et** `FORCE ROW LEVEL SECURITY` sur les **18** tables métier : même le propriétaire des tables est filtré (protège contre les requêtes oubliées).
- Politique unique `tenant_isolation` : `USING` **et** `WITH CHECK` sur `tenant_id = current_setting('app.tenant_id', true)::uuid` — une écriture vers un autre salon est rejetée, pas seulement invisible.
- Contexte posé par `withTenantClient()` (`server/tenantContext.ts`) : `BEGIN` → `SELECT set_config('app.tenant_id', $1, true)` → travail → `COMMIT`, avec `ROLLBACK` sur exception. La portée `true` (transaction locale) empêche toute fuite entre requêtes d'une connexion mutualisée.
- Clés primaires composites `(tenant_id, id)` sur `salon_info` et `app_settings`, dont les identifiants (`salon-main`, `default`) étaient jusqu'ici globaux.

#### Migrations versionnées (P0-4)

- `server/migrations.ts` : registre `schema_migrations`, migrations `001_baseline` (schéma historique) et `002_multi_tenant` (tenancy + RLS).
- Chaque migration s'exécute dans sa propre transaction ; un échec annule la migration et interrompt la séquence (aucune migration à moitié appliquée).
- `ensureNeonSchema()` appelle désormais `runMigrations()` : plus de `CREATE TABLE IF NOT EXISTS` dispersé, et les évolutions futures sont additives.

#### Application

- `SessionTokenPayload` porte `tid` ; les jetons historiques sans `tid` sont rattachés au salon par défaut (compatibilité ascendante).
- `POST /api/sync`, `GET /api/sync/pull`, `POST /api/sync/verify` résolvent le salon depuis la session (`tid`) ou la configuration serveur, puis ouvrent une transaction contextualisée.
- `GET/POST/PATCH /api/users*` lisent et écrivent strictement dans le salon de la session du Gérant ; une session sans salon exploitable est rejetée (`TENANT_REQUIRED`).
- Première inscription sur une instance vierge : création automatique d'une organisation + d'un salon, et l'utilisateur en devient le Gérant. Les inscriptions suivantes sans salon sont rattachées au salon par défaut en attente d'approbation (`MANAGER_APPROVAL_REQUIRED`).
- `loginUserOnNeon` reste volontairement **global** (on ne connaît le salon qu'après identification) puis restreint ses écritures au salon du compte trouvé.

#### Validation

| Commande | Résultat |
|---|---|
| `npm run lint` | 0 erreur, 0 avertissement (111 fichiers) |
| `npm test` | **70/70** tests verts (14 fichiers) |
| `npm run build` | OK |

Nouveaux tests :
- `src/test/tenantIsolation.test.ts` (5) — séparation lecture/écriture entre deux salons, impossibilité d'écraser une ligne homonyme d'un autre salon, comptes cloisonnés et e-mail réutilisable d'un salon à l'autre, session historique sans `tid`, et absence de résultat sans contexte (RLS *fail-closed*).
- `src/test/migrations.test.ts` (4) — identifiants uniques et ordonnés, application unique de chaque migration, contenu du plan de tenancy (19 tables, RLS forcée sur 18, politique `tenant_isolation`, backfill), et arrêt propre en cas d'échec.

#### Limites assumées de cette étape

- Les **membres** (`memberships`) multi-utilisateurs par salon et le changement de salon actif restent à modéliser (P1) : aujourd'hui un compte appartient à un seul salon.
- L'isolation est validée sur simulateur ; un test d'intégration sur une base Neon réelle (deux salons, deux rôles PostgreSQL) doit être ajouté au pipeline avant la mise en production.
- `salon_users` repose sur un filtrage applicatif explicite (`WHERE tenant_id = $1`) : toute nouvelle requête sur cette table doit conserver ce filtre.

### 11.5 Sprint 3 — sessions révocables (implémenté)

#### Modèle de session

| Élément | Choix retenu |
|---|---|
| Jeton d'accès | Jeton HMAC signé, **15 minutes**, claim `sid` (session) + `tid` (salon). Vérifié en base à chaque requête authentifiée : une session révoquée cesse immédiatement de fonctionner |
| Jeton de rafraîchissement | Chaîne opaque de 256 bits, **stockée uniquement hachée** (SHA-256) : une fuite de la base ne permet pas de rejouer les sessions. Durée de vie 30 jours |
| Rotation | Chaque rafraîchissement révoque la session précédente et en émet une nouvelle. Fenêtre de grâce de 30 s pour absorber une réponse perdue (réseau mobile) |
| Détection de vol | Rejouer un jeton déjà consommé (hors grâce) révoque **toutes** les sessions vivantes du compte (`SESSION_REUSED`) |
| Déconnexion | `POST /api/auth/logout` révoque la session immédiatement (`revoked_at`, `revoked_reason`), de façon idempotente |
| Traçabilité | `sessions` conserve `user_agent`, `ip`, `created_at`, `last_used_at`, `revoked_reason` — base de l'écran « appareils connectés » (P1) |

#### Nouvelles routes

| Route | Méthode | Rôle | Réponse |
|---|---|---|---|
| `/api/auth/refresh` | `POST` | public (jeton de rafraîchissement) | `sessionToken`, `refreshToken`, `expiresAt`, `user` ; rate limit 120/quart d'heure par IP |
| `/api/auth/logout` | `POST` | session ou jeton de rafraîchissement | `{ revoked }`, toujours 200 (idempotent) |

`/api/auth/login` et `/api/auth/register` renvoient désormais `sessionToken` (15 min), `refreshToken`, `sessionId`, `expiresAt` et `refreshExpiresAt`.

#### Comportement client

- `src/lib/sessionClient.ts` centralise le stockage des deux jetons (session/local selon « Se souvenir de moi »), le rafraîchissement **avec verrou anti-concurrence** (une seule rotation à la fois, sinon plusieurs 401 simultanés révoqueraient la famille), et la révocation à la déconnexion.
- `fetchWithSession()` rejoue une requête en 401 après une rotation réussie : la synchronisation Cloud et le provisionnement de comptes survivent à l'expiration du jeton d'accès de 15 min.
- Rotation planifiée 60 s avant expiration, plus un rafraîchissement au retour d'onglet.

#### Validation

| Commande | Résultat |
|---|---|
| `npm run lint` | 0 erreur, 0 avertissement (114 fichiers) |
| `npm test` | **76/76** tests verts (15 fichiers) |
| `npm run build` | OK |

`src/test/sessions.test.ts` (6 tests) couvre : émission d'un jeton court avec `sid`, rotation effective du jeton de rafraîchissement, révocation de toute la famille sur rejeu, refus immédiat d'un jeton d'accès après déconnexion, jetons inconnus/vides, et idempotence de la déconnexion.

#### Limites assumées

- Les jetons émis **avant** ce déploiement (sans `sid`) restent valides jusqu'à leur expiration (30 jours) et échappent donc à la révocation : à échéance, plus aucun jeton sans session ne circule.
- La table `sessions` n'est pas purgée automatiquement (les lignes expirées s'accumulent) : une tâche `DELETE FROM sessions WHERE expires_at < now() - interval '30 days'` est à planifier avec les sauvegardes (P1).
- L'écran d'administration des appareils connectés et la révocation ciblée par le Gérant restent à construire (P1).


### 11.7 Sprint 4 — synchronisation delta serveur-autoritaire (implémenté)

#### Principe

| Avant (Sprint 3) | Après (P0-6) |
|---|---|
| Le client décidait de l'ordre via `updated_at` (horloge locale) | Le **serveur** décide : chaque push est appliqué à son arrivée, après comparaison des contenus réellement stockés |
| Chaque pull renvoyait **tout** l'état du salon | Un client présente un **curseur** et ne reçoit que les changements survenus depuis |
| Aucune trace des changements (impossible de savoir qui a bougé quoi) | Journal immuable `sync_changes` avec révision monotone par salon |

#### Schéma (migration `004_sync_revisions`)

- `sync_state (tenant_id, revision)` : compteur de révision **verrouillé** (`SELECT … FOR UPDATE`) pendant chaque push. Les révisions sont donc attribuées et validées dans l'ordre : un lecteur qui a vu la révision *N* a vu toutes les précédentes.
- `sync_changes (tenant_id, seq, table_name, row_id, op, payload_json)` : journal des changements acceptés (`upsert` / `delete`), indexé par `(tenant_id, seq)`.
- Les deux tables sont protégées par RLS (`tenant_isolation`, `USING` + `WITH CHECK`).

#### Fonctionnement d'un push

1. Lecture de l'état **avant** application (dans la même transaction).
2. Application « à l'aveugle » (sans curseur) : les lignes dont l'horodatage est **antérieur** à l'état serveur sont écartées — un appareil resté hors-ligne ne peut plus écraser des données récentes.
3. Application avec curseur (client à jour) : les contenus sont comparés (`payload_json IS DISTINCT FROM EXCLUDED.payload_json`), l'ordre d'arrivée fait foi.
4. Lecture de l'état **après**, calcul du delta réel (contenus comparés, jamais les horodatages clients).
5. Attribution des révisions et journalisation dans `sync_changes`.
6. Réponse : `cursor`, `changes` (par table), `deleted` (tombstones) — et l'état complet uniquement si le client n'a pas fourni de curseur.

#### API

| Route | Paramètre | Réponse |
|---|---|---|
| `POST /api/sync` | `cursor?` dans le corps | `cursor`, `changes`, `deleted` (+ `payload` complet si aucun curseur) |
| `GET /api/sync/pull?since=<cursor>` | `since` | delta condensé (une entrée par ligne, la plus récente) + `cursor` |

#### Côté client

- `CloudSyncProvider` persiste le curseur (`salon_pro_cloud_sync_cursor`), l'envoie à chaque push et l'avance à la réponse.
- Nouveau `mergeCloudDelta()` : fusionne **uniquement** les tables présentes dans `changes`, applique `deleted`, et laisse intact le reste de l'état local.

#### Validation

| Commande | Résultat |
|---|---|
| `npm run lint` | 0 erreur, 0 avertissement (115 fichiers) |
| `npm test` | **82/82** tests verts (16 fichiers) |
| `npm run build` | OK |

`src/test/deltaSync.test.ts` (6 tests) couvre : état complet puis delta ciblé, autorité serveur face à une horloge client « 2099 », absence de révision quand rien ne change, propagation des suppressions, cloisonnement des journaux par salon, et fusion d'un delta côté client (tables absentes préservées, suppressions appliquées).

#### Limites assumées

- Le journal `sync_changes` n'est pas encore compacté : prévoir une purge (par exemple conserver 30 jours ou les 10 000 dernières révisions par salon) avec la tâche de maintenance P1.
- La granularité du delta est **la ligne**, pas le champ : deux appareils qui modifient deux champs différents de la même ligne gardent le dernier reçu (résolution « dernière écriture reçue »).
- Un push reste un instantané complet côté client : le suivi des seules lignes modifiées (dirty tracking) réduira encore la charge réseau (P1).

### 11.8 Reste à faire

1. **P0-7** — service worker / mode hors-ligne réel.
2. **P1** — `memberships` multi-salons, garde de rôle sur les routes métier, abonnements et limites de plan, purge des sessions et du journal de synchronisation, écran « appareils connectés », dirty tracking côté client.


## Annexe A — Inventaire des fichiers (par rôle)

| Zone | Fichiers notables |
|---|---|
| Application | `src/main.tsx`, `src/app/App.tsx`, `src/app/router.tsx` (13 pages, 19 déclarations de route) |
| Contextes | `AuthProvider`, `CloudSyncProvider`, `PeriodFilterProvider`, `CashSessionProvider`, `QuickActionProvider`, `WorkspaceFocusProvider`, `SalonStoreProvider` |
| Domaine | `models/index.ts` (~470 l), `calculations/finance.ts` (18 fonctions), `validators/index.ts` (6 validateurs), `mockPurge.ts` |
| Persistance | `db/database.ts` (Dexie v1→v4), `db/repositories/salonRepositories.ts` (3 608 l), `db/seed.ts`, `db/freshBarberCatalog.ts` (gabarit, non injecté) |
| Serveur | `api/[...route].ts`, `server/apiHandler.ts` (367 l), `server/authEngine.ts` (450 l), `server/syncEngine.ts` (903 l), `server/neonClient.ts`, `server/neonSchema.ts`, `server/viteApiPlugin.ts` |
| UI | 36 composants (`ui/` 18, `patterns/` 12, `reui/` 1), 3 modales de caisse, `MainLayout`, `CommandSearchModal` |
| Tests | 11 fichiers (`calculations`, `authFlows`, `neonSync`, `contextsAndBusinessFlows`, `repositoryAndUi`, `servicesConfig`, 5 fichiers ReUI) |

## Annexe B — Les 7 routes API et leur état d'autorisation

Voir §2.4. Aucune route `/api/sync*` ne contrôle le rôle ; seule l'existence d'un jeton (ou d'un PIN global) est vérifiée.

## Annexe C — Commandes de reproduction de l'audit

```bash
npm install
npm run lint        # 0 erreur, 0 avertissement
npm test            # 49/49 après correctif P0-0 (46/49 avant)
npm run build       # OK — 1,31 Mo JS, chunk principal 540 kB
git diff --stat     # correctif P0-0 : 2 fichiers, -62/+14
```

## Annexe D — Hypothèses et limites

- Les volumes de données cibles (nombre de salons, d'écritures) ne sont pas connus : les estimations de charge restent qualitatives.
- Les coûts WhatsApp/PSP cités sont des ordres de grandeur de marché, à confirmer par devis.
- L'audit n'a pas inclus de revue juridique (contrats SaaS, ARTCI, mentions légales des reçus).

## Annexe E — Nettoyage optionnel du catalogue pré-rempli (installations existantes)

À exécuter **uniquement** si l'opérateur souhaite revenir à un catalogue vide (aucune donnée transactionnelle n'est touchée ; les recettes conservent leur libellé et leur montant).

```ts
// Console du navigateur, application ouverte sur le salon concerné
const db = await import('/src/db/database.ts').then((m) => m.db)
const stale = await db.services
  .filter((s) => s.id.startsWith('fresh-barber-service-'))
  .toArray()
await db.transaction('rw', [db.services, db.categories, db.syncTombstones], async () => {
  const now = new Date().toISOString()
  for (const s of stale) {
    await db.services.delete(s.id)
    await db.syncTombstones.put({
      id: `service:${s.id}`,
      entityType: 'service',
      entityId: s.id,
      deletedAt: now,
    })
  }
  const cats = await db.categories
    .filter((c) => c.code.startsWith('fresh_'))
    .toArray()
  await db.categories.bulkDelete(cats.map((c) => c.id))
})
// Puis lancer une synchronisation pour propager les tombstones au cloud.
```

> Les tombstones sont indispensables : sans eux, la prochaine synchronisation ramènerait les prestations depuis le cloud.

---

### Conclusion

`IMPLEMENTATIONS.md` décrit la bonne cible, dans le bon ordre, avec la bonne intuition technique (« ne jamais faire confiance au `tenantId` du navigateur »). L'application actuelle en réalise le **cœur métier financier avec une qualité rare**, mais elle est encore **mono-salon et sans autorisation serveur** : deux failles (S1, S2) interdisent aujourd'hui toute commercialisation multicolocation. Le chantier décisif n'est pas d'ajouter des fonctionnalités, mais de **transformer les fondations en 6 à 8 semaines** (P0), puis d'enchaîner immédiatement sur les abonnements et la console éditeur pour rendre le produit **encaissable**.
