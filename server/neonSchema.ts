export const NEON_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  date TEXT NOT NULL,
  client_name TEXT,
  client_phone TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  subtotal BIGINT NOT NULL DEFAULT 0,
  tax_amount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  linked_revenue_id TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (date);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON invoices (payment_status);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices (invoice_number);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  org_id TEXT NOT NULL,
  plan_code TEXT,
  amount_fcfa BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  callback_url TEXT,
  return_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  psp_transaction_id TEXT,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_org ON payment_transactions (org_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions (status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_reference ON payment_transactions (reference);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  source TEXT NOT NULL DEFAULT 'walkin',
  loyalty_points BIGINT NOT NULL DEFAULT 0,
  loyalty_tier TEXT NOT NULL DEFAULT 'bronze',
  total_visits BIGINT NOT NULL DEFAULT 0,
  total_spent BIGINT NOT NULL DEFAULT 0,
  last_visit_at TEXT,
  note TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);
CREATE INDEX IF NOT EXISTS idx_clients_is_active ON clients (is_active);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  employee_id TEXT,
  employee_name TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'walkin',
  amount BIGINT NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments (client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_start_at ON appointments (start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
`
