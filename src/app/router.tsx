import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { MainLayout } from '../components/layout/MainLayout'
import { useAuth } from '../contexts/authContext'
import { CashSessionProvider } from '../contexts/CashSessionProvider'
import { CloudSyncProvider } from '../contexts/CloudSyncProvider'
import { PeriodFilterProvider } from '../contexts/PeriodFilterProvider'
import { QuickActionProvider } from '../contexts/QuickActionProvider'
import { WorkspaceFocusProvider } from '../contexts/WorkspaceFocusProvider'

const LoginPage = lazy(() =>
  import('../features/auth/LoginPage').then((m) => ({
    default: m.LoginPage,
  })),
)
const RegisterPage = lazy(() =>
  import('../features/auth/RegisterPage').then((m) => ({
    default: m.RegisterPage,
  })),
)
const DashboardPage = lazy(() =>
  import('../features/dashboard/DashboardPage').then((m) => ({
    default: m.DashboardPage,
  })),
)
const CashPage = lazy(() =>
  import('../features/cash/CashPage').then((m) => ({ default: m.CashPage })),
)
const RevenuePage = lazy(() =>
  import('../features/revenue/RevenuePage').then((m) => ({
    default: m.RevenuePage,
  })),
)
const ExpensesPage = lazy(() =>
  import('../features/expenses/ExpensesPage').then((m) => ({
    default: m.ExpensesPage,
  })),
)
const ServicesPage = lazy(() =>
  import('../features/services/ServicesPage').then((m) => ({
    default: m.ServicesPage,
  })),
)
const EmployeesPage = lazy(() =>
  import('../features/employees/EmployeesPage').then((m) => ({
    default: m.EmployeesPage,
  })),
)
const PayrollPage = lazy(() =>
  import('../features/payroll/PayrollPage').then((m) => ({
    default: m.PayrollPage,
  })),
)
const InventoryPage = lazy(() =>
  import('../features/inventory/InventoryPage').then((m) => ({
    default: m.InventoryPage,
  })),
)
const ReportsPage = lazy(() =>
  import('../features/reports/ReportsPage').then((m) => ({
    default: m.ReportsPage,
  })),
)
const BudgetPage = lazy(() =>
  import('../features/budget/BudgetPage').then((m) => ({
    default: m.BudgetPage,
  })),
)
const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage').then((m) => ({
    default: m.SettingsPage,
  })),
)
const TeamPage = lazy(() =>
  import('../features/team/TeamPage').then((m) => ({
    default: m.TeamPage,
  })),
)

function RouteFallback() {
  return (
    <div
      style={{
        padding: '32px 16px',
        color: 'var(--text-muted)',
        fontSize: '0.86rem',
      }}
    >
      Chargement du module…
    </div>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { authEnforced, authReady, currentUser } = useAuth()
  const location = useLocation()

  if (!authEnforced) {
    return <>{children}</>
  }
  if (!authReady) {
    return <RouteFallback />
  }
  if (!currentUser) {
    return (
      <Navigate to="/login" state={{ from: location.pathname }} replace />
    )
  }
  return <>{children}</>
}

function RequireManagerRole({ children }: { children: ReactNode }) {
  const { authEnforced, currentUser } = useAuth()
  if (authEnforced && currentUser && currentUser.role !== 'manager') {
    return <Navigate to="/cash" replace />
  }
  return <>{children}</>
}

export function AppRoutes() {
  return (
    <CloudSyncProvider>
      <PeriodFilterProvider>
        <CashSessionProvider>
          <WorkspaceFocusProvider>
            <QuickActionProvider>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/register" element={<RegisterPage />} />

                  <Route
                    path="/"
                    element={
                      <RequireAuth>
                        <MainLayout />
                      </RequireAuth>
                    }
                  >
                    <Route
                      index
                      element={<Navigate to="/dashboard" replace />}
                    />
                    <Route path="dashboard" element={<DashboardPage />} />
                    <Route path="cash" element={<CashPage />} />
                    <Route path="revenue" element={<RevenuePage />} />
                    <Route path="expenses" element={<ExpensesPage />} />
                    <Route path="services" element={<ServicesPage />} />
                    <Route
                      path="employees"
                      element={
                        <RequireManagerRole>
                          <EmployeesPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route
                      path="payroll"
                      element={
                        <RequireManagerRole>
                          <PayrollPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route path="inventory" element={<InventoryPage />} />
                    <Route
                      path="reports"
                      element={
                        <RequireManagerRole>
                          <ReportsPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route
                      path="budget"
                      element={
                        <RequireManagerRole>
                          <BudgetPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route
                      path="settings"
                      element={
                        <RequireManagerRole>
                          <SettingsPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route
                      path="team"
                      element={
                        <RequireManagerRole>
                          <TeamPage />
                        </RequireManagerRole>
                      }
                    />
                    <Route
                      path="*"
                      element={<Navigate to="/dashboard" replace />}
                    />
                  </Route>
                </Routes>
              </Suspense>
            </QuickActionProvider>
          </WorkspaceFocusProvider>
        </CashSessionProvider>
      </PeriodFilterProvider>
    </CloudSyncProvider>
  )
}
