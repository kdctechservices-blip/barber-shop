import type { CategoryItem, ServiceCatalogItem } from '../domain/models'

const CATEGORY_DEFINITIONS = [
  { code: 'fresh_coupes_hommes', label: 'COUPES HOMMES' },
  {
    code: 'fresh_soins_visage_barbe_pieds_mains',
    label: 'SOINS VISAGE-BARBE-PIEDS&MAINS',
  },
  { code: 'fresh_coiffures_hf', label: 'COIFFURES H/F' },
  { code: 'fresh_traitement', label: 'TRAITEMENT' },
  { code: 'fresh_locks_adultes', label: 'LOCKS ADULTES' },
] as const

type ServiceSeed = {
  name: string
  categoryCode: (typeof CATEGORY_DEFINITIONS)[number]['code']
  price: number
  durationMinutes: number
}

const SERVICE_DEFINITIONS: ServiceSeed[] = [
  // COUPES HOMMES (10)
  { name: 'Coupe adulte (18 ans et +)', categoryCode: 'fresh_coupes_hommes', price: 5000, durationMinutes: 30 },
  { name: 'Coupe Ado (jusqu\'à17ans)', categoryCode: 'fresh_coupes_hommes', price: 3000, durationMinutes: 30 },
  { name: 'Coupe européenne adulte', categoryCode: 'fresh_coupes_hommes', price: 9000, durationMinutes: 30 },
  { name: 'Limitation et taille de la barbe', categoryCode: 'fresh_coupes_hommes', price: 2000, durationMinutes: 30 },
  { name: 'Taper Low - Mid - High', categoryCode: 'fresh_coupes_hommes', price: 4000, durationMinutes: 30 },
  { name: 'Coupes Fade (Burst, taper,..)', categoryCode: 'fresh_coupes_hommes', price: 6000, durationMinutes: 30 },
  { name: 'Wave', categoryCode: 'fresh_coupes_hommes', price: 12000, durationMinutes: 45 },
  { name: 'Coupe enfant (jusqu\'à 11ans)', categoryCode: 'fresh_coupes_hommes', price: 2000, durationMinutes: 30 },
  { name: 'Coupes européenne enfant', categoryCode: 'fresh_coupes_hommes', price: 5000, durationMinutes: 30 },
  { name: 'Coco taillé &limitation de la barbe', categoryCode: 'fresh_coupes_hommes', price: 4000, durationMinutes: 20 },

  // SOINS VISAGE-BARBE-PIEDS&MAINS (9)
  { name: 'Soin hydratant (Shampooing, hydratation et massage relaxant) et taille de la barbe', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 5000, durationMinutes: 30 },
  { name: 'Soin douceur des mains (sans vernis)', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 5000, durationMinutes: 40 },
  { name: 'Soin douceur des mains + vernis normal', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 6000, durationMinutes: 60 },
  { name: 'Soin douceur des mains + vernis semi-permanent', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 8000, durationMinutes: 60 },
  { name: 'Spa des pieds sans pose de vernis', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 6000, durationMinutes: 60 },
  { name: 'Spa des pieds + vernis normal', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 7000, durationMinutes: 60 },
  { name: 'Spa des pieds + vernis semi permanent', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 9000, durationMinutes: 60 },
  { name: 'Soin complet du visage (vapeur Ozone, nettoyage, serviette chaude, gommage, black mask, hydratation, massage)', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 20000, durationMinutes: 60 },
  { name: 'Soin hydratant du visage (vapeur Ozone, nettoyage, gommage, hydratation, massage)', categoryCode: 'fresh_soins_visage_barbe_pieds_mains', price: 15000, durationMinutes: 30 },

  // COIFFURES H/F (8)
  { name: 'Curly tête complète', categoryCode: 'fresh_coiffures_hf', price: 15000, durationMinutes: 120 },
  { name: 'Curly demi-tête', categoryCode: 'fresh_coiffures_hf', price: 10000, durationMinutes: 120 },
  { name: 'Twists/vanilles tête complète', categoryCode: 'fresh_coiffures_hf', price: 25000, durationMinutes: 90 },
  { name: 'Twists/vanilles demi-tête', categoryCode: 'fresh_coiffures_hf', price: 20000, durationMinutes: 90 },
  { name: 'Nattes simples + taper (cheveux long)', categoryCode: 'fresh_coiffures_hf', price: 15000, durationMinutes: 90 },
  { name: 'Barrels twist tête complète', categoryCode: 'fresh_coiffures_hf', price: 40000, durationMinutes: 120 },
  { name: 'Barrels twist demi-tête', categoryCode: 'fresh_coiffures_hf', price: 30000, durationMinutes: 120 },
  { name: 'Nattes complexes + taper (cheveux longs)', categoryCode: 'fresh_coiffures_hf', price: 25000, durationMinutes: 120 },

  // TRAITEMENT (5)
  { name: 'Défrisage avec pot client(e)', categoryCode: 'fresh_traitement', price: 5000, durationMinutes: 30 },
  { name: 'Défrisage avec pot du salon', categoryCode: 'fresh_traitement', price: 8000, durationMinutes: 30 },
  { name: 'Shampooing hydratant', categoryCode: 'fresh_traitement', price: 3000, durationMinutes: 30 },
  { name: 'Décoloration sur cheveux court', categoryCode: 'fresh_traitement', price: 15000, durationMinutes: 120 },
  { name: 'Coloration semi permanente sur cheveux court', categoryCode: 'fresh_traitement', price: 15000, durationMinutes: 120 },

  // LOCKS ADULTES (6)
  { name: 'Départ locks tête complète (sur cheveux naturels)', categoryCode: 'fresh_locks_adultes', price: 80000, durationMinutes: 240 },
  { name: 'Départ locks demi-tête (sur cheveux naturels)', categoryCode: 'fresh_locks_adultes', price: 40000, durationMinutes: 240 },
  { name: 'Départ sister locks toute la tête (sur cheveux naturels)', categoryCode: 'fresh_locks_adultes', price: 120000, durationMinutes: 360 },
  { name: 'Resserage locks toute la tête', categoryCode: 'fresh_locks_adultes', price: 20000, durationMinutes: 120 },
  { name: 'Resserrage locks demi tête', categoryCode: 'fresh_locks_adultes', price: 15000, durationMinutes: 240 },
  { name: 'Shampooing locks', categoryCode: 'fresh_locks_adultes', price: 5000, durationMinutes: 60 },
]

export function buildFreshBarberCatalog(nowIso = new Date().toISOString()): {
  categories: CategoryItem[]
  services: ServiceCatalogItem[]
} {
  const categories: CategoryItem[] = CATEGORY_DEFINITIONS.map((item) => ({
    id: `cat-service-${item.code}`,
    scope: 'service',
    code: item.code,
    label: item.label,
    isSystem: false,
    isArchived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }))

  const services: ServiceCatalogItem[] = SERVICE_DEFINITIONS.map((item, index) => ({
    id: `fresh-barber-service-${String(index + 1).padStart(2, '0')}`,
    name: item.name,
    categoryCode: item.categoryCode,
    referencePrice: item.price,
    description: '',
    durationMinutes: item.durationMinutes,
    isActive: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  }))

  return { categories, services }
}
