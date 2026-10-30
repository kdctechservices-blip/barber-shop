import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  salonRepo,
  type FullSalonState,
  type SalonRepositoryHub,
} from '../db/repositories/salonRepositories'
import {
  buildDefaultSalonInfo,
  buildDefaultSettings,
  buildSystemCategories,
} from '../db/seed'
import type { CategoryScope } from '../domain/models'
import { SalonStoreContext } from './salonStoreContext'

function createInitialPlaceholderState(): FullSalonState {
  return {
    salon: buildDefaultSalonInfo(),
    settings: buildDefaultSettings(),
    categories: buildSystemCategories(),
    services: [],
    employees: [],
    revenues: [],
    expenses: [],
    cashSessions: [],
    cashMovements: [],
    advances: [],
    bonuses: [],
    salaryPayments: [],
    products: [],
    stockMovements: [],
    budgets: [],
    recurringExpenses: [],
    correctionLogs: [],
    clients: [],
    appointments: [],
    invoices: [],
  }
}

export function SalonStoreProvider({
  children,
  repository = salonRepo,
}: {
  children: ReactNode
  repository?: SalonRepositoryHub
}) {
  const [state, setState] = useState<FullSalonState>(
    createInitialPlaceholderState,
  )
  const [ready, setReady] = useState(false)
  const [mutationCount, setMutationCount] = useState(0)
  const [dirtyTables, setDirtyTables] = useState<string[]>([])

  const refresh = useCallback(async () => {
    const next = await repository.readFullState()
    setState(next)
    setReady(true)
  }, [repository])

  useEffect(() => {
    let cancelled = false
    void repository.readFullState().then((next) => {
      if (!cancelled) {
        setState(next)
        setReady(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [repository])

  // Appliquer le thème d'interface non sensible sur documentElement + localStorage
  useEffect(() => {
    const theme = state.settings.theme
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('salon_pro_ui_theme', theme)
    } catch {
      // ignore
    }
  }, [state.settings.theme])

  const mutate = useCallback(
    async <R,>(fn: (repo: SalonRepositoryHub) => Promise<R>): Promise<R> => {
      const result = await fn(repository)
      const next = await repository.readFullState()
      setState(next)
      setMutationCount((c) => c + 1)
      setDirtyTables(repository.getDirtyTables())
      return result
    },
    [repository],
  )

  const syncWithRepo = useCallback(
    async <R,>(fn: (repo: SalonRepositoryHub) => Promise<R>): Promise<R> => {
      const result = await fn(repository)
      const next = await repository.readFullState()
      setState(next)
      return result
    },
    [repository],
  )

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of state.categories) {
      map.set(`${c.scope}:${c.code}`, c.label)
    }
    return map
  }, [state.categories])

  const categoryLabel = useCallback(
    (scope: CategoryScope, code: string) =>
      categoryMap.get(`${scope}:${code}`) ?? code,
    [categoryMap],
  )

  const clearDirtyTables = useCallback(() => {
    repository.clearDirtyTables()
    setDirtyTables([])
  }, [repository])

  const value = useMemo(
    () => ({
      state,
      ready,
      mutationCount,
      dirtyTables,
      categoryLabel,
      refresh,
      mutate,
      syncWithRepo,
      clearDirtyTables,
    }),
    [state, ready, mutationCount, dirtyTables, categoryLabel, refresh, mutate, syncWithRepo, clearDirtyTables],
  )

  return (
    <SalonStoreContext.Provider value={value}>
      {children}
    </SalonStoreContext.Provider>
  )
}
