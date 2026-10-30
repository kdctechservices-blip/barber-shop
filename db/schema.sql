-- ============================================================================
-- SALON PRO — Schéma relationnel PostgreSQL (Neon Serverless Postgres)
-- Montants financiers en Francs CFA entiers (BIGINT), horodatages ISO-8601
-- Compatible mode Hybride Offline-First (IndexedDB Dexie <-> Neon PostgreSQL)
--
-- ATTENTION : ce fichier est la photographie de la migration 001_baseline.
-- Le schéma appliqué en production est piloté par server/migrations.ts.
-- La migration 002_multi_tenant y ajoute organizations, tenants, tenant_id
-- sur les 19 tables et les politiques RLS tenant_isolation.
-- La migration 003_sessions y ajoute la table sessions (jetons révocables).
-- La migration 004_sync_revisions y ajoute sync_state et sync_changes (delta).
-- ============================================================================

CREATE TABLE IF NOT EXISTS salon_info (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  manager_name TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'XOF',
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'light',
  date_format TEXT NOT NULL DEFAULT 'dd/MM/yyyy',
  receipt_format TEXT DEFAULT 'thermal_80mm',
  last_backup_exported_at TEXT,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_scope ON categories (scope);

CREATE TABLE IF NOT EXISTS services_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_code TEXT NOT NULL,
  reference_price BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  base_salary BIGINT NOT NULL DEFAULT 0,
  remuneration_type TEXT NOT NULL DEFAULT 'fixed',
  commission_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  commission_rate NUMERIC(6, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  opening_balance BIGINT NOT NULL DEFAULT 0,
  theoretical_closing_balance BIGINT NOT NULL DEFAULT 0,
  counted_closing_balance BIGINT,
  discrepancy BIGINT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions (status);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_opened_at ON cash_sessions (opened_at);

CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements (session_id);

CREATE TABLE IF NOT EXISTS revenues (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  receipt_number TEXT,
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  category_code TEXT NOT NULL,
  employee_id TEXT,
  amount BIGINT NOT NULL,
  payment_method TEXT NOT NULL,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenues_date ON revenues (date);
CREATE INDEX IF NOT EXISTS idx_revenues_ticket ON revenues (ticket_id);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  category_code TEXT NOT NULL,
  amount BIGINT NOT NULL,
  payment_method TEXT NOT NULL,
  source_module TEXT NOT NULL,
  is_stock_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date);

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category_code TEXT NOT NULL,
  default_amount BIGINT NOT NULL,
  day_of_month INTEGER NOT NULL DEFAULT 5,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category_code TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  cost_price BIGINT NOT NULL DEFAULT 0,
  sale_price BIGINT,
  alert_threshold INTEGER NOT NULL DEFAULT 0,
  usage_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  unit_cost BIGINT NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements (product_id);

CREATE TABLE IF NOT EXISTS advances (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  period_month TEXT NOT NULL,
  amount BIGINT NOT NULL,
  paid_at TEXT NOT NULL,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_advances_period ON advances (period_month);

CREATE TABLE IF NOT EXISTS bonuses (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  period_month TEXT NOT NULL,
  amount BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_payments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  period_month TEXT NOT NULL,
  net_paid_amount BIGINT NOT NULL,
  is_partial BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_salary_payments_period ON salary_payments (period_month);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  period_month TEXT NOT NULL,
  kind TEXT NOT NULL,
  category_code TEXT NOT NULL,
  planned_amount BIGINT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budgets_period ON budgets (period_month);

CREATE TABLE IF NOT EXISTS correction_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS salon_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_salon_users_email ON salon_users (email);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
