import { createContext, useContext } from 'react'
import type {
  FullSalonState,
  SalonRepositoryHub,
} from '../db/repositories/salonRepositories'
import type { CategoryScope } from '../domain/models'

export interface SalonStoreContextValue {
  state: FullSalonState
  ready: boolean
  mutationCount: number
  dirtyTables: string[]
  categoryLabel: (scope: CategoryScope, code: string) => string
  refresh: () => Promise<void>
  mutate: <R>(fn: (repo: SalonRepositoryHub) => Promise<R>) => Promise<R>
  syncWithRepo: <R>(fn: (repo: SalonRepositoryHub) => Promise<R>) => Promise<R>
  clearDirtyTables: () => void
}

export const SalonStoreContext = createContext<SalonStoreContextValue | null>(
  null,
)

export function useSalonStore(): SalonStoreContextValue {
  const ctx = useContext(SalonStoreContext)
  if (!ctx) {
    throw new Error('useSalonStore doit être utilisé dans SalonStoreProvider')
  }
  return ctx
}
