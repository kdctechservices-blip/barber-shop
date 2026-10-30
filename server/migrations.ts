import type { SqlPoolLike } from './neonClient.ts'
import { NEON_SCHEMA_SQL } from './neonSchema.ts'
import { DEFAULT_ORGANIZATION_ID, DEFAULT_TENANT_ID } from './tenantContext.ts'

/**
 * SALON PRO — Migrations PostgreSQL versionnées.
 *
 * Remplace l'ancien `CREATE TABLE IF NOT EXISTS` monolithique : chaque
 * évolution de schéma est une migration numérotée, jouée une seule fois et
 * tracée dans `schema_migrations`.
 *
 * Convention : ne JAMAIS modifier une migration déjà livrée. On ajoute.
 */

export interface Migration {
  id: string
  label: string
  sql: string
}

/** Migration 002 — socle multi-tenant (organisations, salons, RLS). */
const TENANCY_SQL = `
-- 1. Organisations et salons (tenants)
CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active',
  timezone   text NOT NULL DEFAULT 'Africa/Abidjan',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_org ON tenants (org_id);

-- 2. Organisation et salon par défaut (installations mono-salon existantes)
INSERT INTO organizations (id, name)
VALUES ('${DEFAULT_ORGANIZATION_ID}', 'SALON PRO — Organisation par défaut')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenants (id, org_id, slug, name, status)
VALUES ('${DEFAULT_TENANT_ID}', '${DEFAULT_ORGANIZATION_ID}', 'default', 'Salon principal', 'active')
ON CONFLICT (id) DO NOTHING;

-- 3. tenant_id sur les 19 tables métier + isolation RLS
DO $$
DECLARE
  tbl text;
  default_tenant uuid := '${DEFAULT_TENANT_ID}';
  isolated_tables text[] := ARRAY[
    'salon_info', 'app_settings', 'categories', 'services_catalog', 'employees',
    'cash_sessions', 'cash_movements', 'revenues', 'expenses', 'recurring_expenses',
    'products', 'stock_movements', 'advances', 'bonuses', 'salary_payments',
    'budgets', 'correction_logs', 'sync_tombstones'
  ];
  all_tables text[] := isolated_tables || ARRAY['salon_users'];
BEGIN
  FOREACH tbl IN ARRAY all_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', tbl);
    EXECUTE format('UPDATE %I SET tenant_id = %L WHERE tenant_id IS NULL', tbl, default_tenant);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', tbl);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'', true)::uuid',
      tbl
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', 'idx_' || tbl || '_tenant', tbl);
  END LOOP;

  -- Isolation stricte : même le propriétaire des tables est soumis aux politiques.
  FOREACH tbl IN ARRAY isolated_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      tbl
    );
  END LOOP;
END $$;

-- 4. Clés primaires composites sur les tables à identifiant fixe
--    (salon-main et default sont identiques pour tous les salons).
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['salon_info', 'app_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = tbl
        AND c.contype = 'p'
        AND pg_get_constraintdef(c.oid) LIKE '%(tenant_id, id)%'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', tbl, tbl || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (tenant_id, id)', tbl);
    END IF;
  END LOOP;
END $$;

-- 5. Comptes : unicité par salon et non plus globalement
ALTER TABLE salon_users DROP CONSTRAINT IF EXISTS salon_users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS salon_users_tenant_email_key
  ON salon_users (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS salon_users_tenant_created_idx
  ON salon_users (tenant_id, created_at);
`

export const MIGRATIONS: Migration[] = [
  {
    id: '001_baseline',
    label: 'Schéma initial SALON PRO (19 tables)',
    sql: NEON_SCHEMA_SQL,
  },
  {
    id: '002_multi_tenant',
    label: 'Organisations, salons et isolation RLS',
    sql: TENANCY_SQL,
  },
]

/**
 * Applique les migrations manquantes, dans l'ordre, chacune dans sa propre
 * transaction. Idempotent : une migration déjà tracée n'est jamais rejouée.
 */
export async function runMigrations(
  pool: SqlPoolLike,
): Promise<{ applied: string[]; alreadyApplied: number }> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )

  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id ASC',
  )
  const appliedIds = new Set(existing.rows.map((row) => row.id))
  const applied: string[] = []

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Verrou consultatif transactionnel : deux instances serverless qui
      // démarrent simultanément ne peuvent pas appliquer la même migration
      // en parallèle (la seconde attend, puis voit la migration enregistrée).
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('salon_schema_migrations'))",
      )
      await client.query(migration.sql)
      await client.query(
        'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [migration.id],
      )
      await client.query('COMMIT')
      applied.push(migration.id)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(
        `Migration ${migration.id} (${migration.label}) échouée : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } finally {
      client.release()
    }
  }

  return { applied, alreadyApplied: appliedIds.size }
}
