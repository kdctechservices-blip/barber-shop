import {
  Plus,
  Trash2,
  Printer,
  X,
  Receipt,
  Wallet,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { KpiCard } from '@/components/ui/KpiCard'
import { Modal } from '@/components/ui/Modal'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type {
  Invoice,
  InvoiceItem,
  InvoicePaymentStatus,
  PaymentMethodCode,
} from '../../domain/models'
import { useSalonStore } from '../../hooks/salonStoreContext'
import { useToast } from '../../hooks/toastContext'
import {
  formatDateFR,
  formatFCFA,
  todayISO,
} from '../../utils/format'

const PAYMENT_METHODS: PaymentMethodCode[] = [
  'cash',
  'wave',
  'orange_money',
  'mtn_momo',
  'transfer',
  'card',
  'other',
]

const PAYMENT_STATUSES: InvoicePaymentStatus[] = [
  'pending',
  'paid',
  'partial',
  'overdue',
  'cancelled',
]

function paymentMethodLabel(code: PaymentMethodCode): string {
  const labels: Record<PaymentMethodCode, string> = {
    cash: 'Espèces',
    wave: 'Wave',
    orange_money: 'Orange Money',
    mtn_momo: 'MTN MoMo',
    transfer: 'Virement bancaire',
    card: 'Carte bancaire',
    other: 'Autre',
  }
  return labels[code] ?? code
}

function paymentStatusLabel(status: InvoicePaymentStatus): string {
  const labels: Record<InvoicePaymentStatus, string> = {
    pending: 'En attente',
    paid: 'Payée',
    partial: 'Partiellement payée',
    overdue: 'En retard',
    cancelled: 'Annulée',
  }
  return labels[status] ?? status
}

function paymentStatusVariant(status: InvoicePaymentStatus): 'default' | 'success' | 'warning' | 'destructive' {
  switch (status) {
    case 'paid': return 'success'
    case 'pending':
    case 'partial': return 'warning'
    case 'overdue': return 'destructive'
    case 'cancelled': return 'default'
    default: return 'default'
  }
}

function nextInvoiceNumber(existing: Invoice[]): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `F-${year}${month}-`
  const sameMonth = existing
    .filter((inv) => inv.invoiceNumber.startsWith(prefix))
    .map((inv) => {
      const m = inv.invoiceNumber.match(/F-\d{6}-(\d+)$/)
      return m ? Number(m[1]) : 0
    })
  const next = Math.max(0, ...sameMonth) + 1
  return `${prefix}${String(next).padStart(3, '0')}`
}

export function InvoicesPage() {
  const { state, mutate } = useSalonStore()
  const toast = useToast()

  const [openCreateModal, setOpenCreateModal] = useState(false)
  const [openDeleteConfirm, setOpenDeleteConfirm] = useState(false)
  const [invoiceToDelete, setInvoiceToDelete] = useState<string | null>(null)
  const [openPrint, setOpenPrint] = useState(false)
  const [invoiceToPrint, setInvoiceToPrint] = useState<Invoice | null>(null)

  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<InvoicePaymentStatus | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const invoices = useMemo(() => {
    let result = [...state.invoices].filter((inv) => !inv.isArchived)

    if (dateFrom) {
      result = result.filter((inv) => inv.date >= dateFrom)
    }
    if (dateTo) {
      result = result.filter((inv) => inv.date <= dateTo)
    }
    if (statusFilter !== 'all') {
      result = result.filter((inv) => inv.paymentStatus === statusFilter)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (inv) =>
          inv.invoiceNumber.toLowerCase().includes(q) ||
          (inv.clientName ?? '').toLowerCase().includes(q) ||
          (inv.clientPhone ?? '').toLowerCase().includes(q),
      )
    }

    return result.sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [state.invoices, dateFrom, dateTo, statusFilter, searchQuery])

  const totalInvoiced = useMemo(
    () => invoices.reduce((sum, inv) => sum + inv.total, 0),
    [invoices],
  )
  const totalPending = useMemo(
    () =>
      invoices
        .filter((inv) => inv.paymentStatus === 'pending' || inv.paymentStatus === 'partial')
        .reduce((sum, inv) => sum + inv.total, 0),
    [invoices],
  )
  const totalPaid = useMemo(
    () =>
      invoices.filter((inv) => inv.paymentStatus === 'paid').reduce((sum, inv) => sum + inv.total, 0),
    [invoices],
  )

  const handleCreateInvoice = useCallback(
    async (values: {
      invoiceNumber: string
      date: string
      clientName?: string
      clientPhone?: string
      items: InvoiceItem[]
      subtotal: number
      taxAmount: number
      total: number
      paymentMethod: PaymentMethodCode
      paymentStatus: InvoicePaymentStatus
    }) => {
      const now = new Date().toISOString()
      const invoice: Invoice = {
        id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        invoiceNumber: values.invoiceNumber,
        date: values.date,
        clientName: values.clientName ?? undefined,
        clientPhone: values.clientPhone ?? undefined,
        items: values.items,
        subtotal: values.subtotal,
        taxAmount: values.taxAmount,
        total: values.total,
        paymentMethod: values.paymentMethod,
        paymentStatus: values.paymentStatus,
        createdAt: now,
        updatedAt: now,
      }
      await mutate(async (repo) => repo.invoicesRepo.create(invoice))
      toast.success(`Facture ${invoice.invoiceNumber} créée.`)
      setOpenCreateModal(false)
    },
    [mutate, toast],
  )

  const handleDeleteInvoice = useCallback(async () => {
    if (!invoiceToDelete) return
    await mutate(async (repo) => {
      await repo.invoicesRepo.update(invoiceToDelete, {
        isArchived: true,
        updatedAt: new Date().toISOString(),
      })
    })
    toast.success('Facture archivée.')
    setInvoiceToDelete(null)
    setOpenDeleteConfirm(false)
  }, [invoiceToDelete, mutate, toast])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Factures</h1>
          <p className="text-muted-foreground">
            Historique de facturation et gestion des factures clients.
          </p>
        </div>
        <Button
          onClick={() => setOpenCreateModal(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={18} className="mr-2" />
          Nouvelle facture
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Factures (période)" value={invoices.length.toLocaleString()} subtitle="Nombre de factures" icon={<Receipt size={16} />} />
        <KpiCard label="Total facturé" value={formatFCFA(totalInvoiced)} subtitle="Montant toutes factures" icon={<Wallet size={16} />} />
        <KpiCard label="En attente / partiel" value={formatFCFA(totalPending)} subtitle="Non totalement payées" icon={<AlertCircle size={16} />} tone="amber" />
        <KpiCard label="Total payé" value={formatFCFA(totalPaid)} subtitle="Factures réglées" icon={<CheckCircle2 size={16} />} tone="emerald" />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Numéro</TableHeaderCell>
                  <TableHeaderCell>Date</TableHeaderCell>
                  <TableHeaderCell>Client</TableHeaderCell>
                  <TableHeaderCell className="text-right">Total</TableHeaderCell>
                  <TableHeaderCell>Statut</TableHeaderCell>
                  <TableHeaderCell className="text-right">Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                      Aucune facture trouvée pour cette période.
                    </TableCell>
                  </TableRow>
                ) : (
                  invoices.map((inv) => (
                    <TableRow key={inv.id} className="hover:bg-muted/50">
                      <TableCell className="font-medium text-sm">
                        {inv.invoiceNumber}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateFR(inv.date)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {inv.clientName ?? '—'}
                        {inv.clientPhone ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({inv.clientPhone})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatFCFA(inv.total)}
                      </TableCell>
                      <TableCell className="text-sm">
                        <Badge variant={paymentStatusVariant(inv.paymentStatus)} className="text-xs">
                          {paymentStatusLabel(inv.paymentStatus)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setInvoiceToPrint(inv)
                            setOpenPrint(true)
                          }}
                        >
                          <Printer size={14} className="mr-1" />
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setInvoiceToDelete(inv.id)
                            setOpenDeleteConfirm(true)
                          }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {invoices.length > 0 && (
            <div className="border-t px-6 py-3 flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {invoices.length} facture(s)
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => window.print()}>
                  <Printer size={14} className="mr-1" />
                  Imprimer la liste
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3 items-end">
        <Field>
          <FieldLabel>Date de</FieldLabel>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            placeholder="Début"
          />
        </Field>
        <Field>
          <FieldLabel>Date à</FieldLabel>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            placeholder="Fin"
          />
        </Field>
        <Field>
          <FieldLabel>Statut</FieldLabel>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as InvoicePaymentStatus | 'all')}
          >
            <SelectTrigger>
              <SelectValue placeholder="Tous" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les statuts</SelectItem>
              {PAYMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {paymentStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Recherche</FieldLabel>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Numéro, client…"
          />
        </Field>
      </div>

      {/* Modal création de facture */}
      <Modal
        open={openCreateModal}
        title="Nouvelle facture"
        onClose={() => setOpenCreateModal(false)}
        maxWidth={600}
      >
        <InvoiceForm
          defaultInvoiceNumber={nextInvoiceNumber(state.invoices)}
          onSubmit={handleCreateInvoice}
        />
      </Modal>

      {/* Confirmation suppression */}
      <ConfirmDialog
        open={openDeleteConfirm}
        title="Archiver la facture ?"
        message="Cette facture sera masquée de l'historique mais conservée pour les archives."
        confirmLabel="Archiver"
        onCancel={() => setOpenDeleteConfirm(false)}
        onConfirm={handleDeleteInvoice}
      />

      {/* Impression d'une facture */}
      <Modal
        open={openPrint}
        title={`Facture ${invoiceToPrint?.invoiceNumber ?? ''}`}
        onClose={() => setOpenPrint(false)}
        maxWidth={540}
      >
        {invoiceToPrint && (
          <div className="max-w-md mx-auto p-4 border bg-white">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-xl font-bold">FACTURE</h2>
                <p className="text-sm text-muted-foreground">
                  N° {invoiceToPrint.invoiceNumber} —
                  {formatDateFR(invoiceToPrint.date)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium">
                  {formatFCFA(invoiceToPrint.total)}
                </p>
                <Badge
                  variant={paymentStatusVariant(invoiceToPrint.paymentStatus)}
                  className="text-xs mt-1"
                >
                  {paymentStatusLabel(invoiceToPrint.paymentStatus)}
                </Badge>
              </div>
            </div>
            {invoiceToPrint.clientName && (
              <p className="text-sm mb-4">
                {invoiceToPrint.clientName}
                {invoiceToPrint.clientPhone ? ` — ${invoiceToPrint.clientPhone}` : ''}
              </p>
            )}
            <table className="w-full text-left text-sm mb-4">
              <thead>
                <tr>
                  <th className="pb-2 text-muted-foreground">Désignation</th>
                  <th className="pb-2 text-muted-foreground text-right w-16">Qté</th>
                  <th className="pb-2 text-muted-foreground text-right w-20">Prix un.</th>
                  <th className="pb-2 text-muted-foreground text-right w-24">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoiceToPrint.items.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-2">{item.label}</td>
                    <td className="py-2 text-right">{item.quantity}</td>
                    <td className="py-2 text-right">{formatFCFA(item.unitPrice)}</td>
                    <td className="py-2 text-right">{formatFCFA(item.amount)}</td>
                  </tr>
                ))}
                <tr className="font-bold border-t pt-4">
                  <td className="text-right" colSpan={3}>
                    Total
                  </td>
                  <td className="py-2 text-right">
                    {formatFCFA(invoiceToPrint.total)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Montants exprimés en Francs CFA (FCFA).
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}

function TableHeaderCell(props: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`h-11 text-left text-xs font-medium text-muted-foreground tracking-wider ${props.className ?? ''}`}
    >
      {props.children}
    </th>
  )
}

interface InvoiceFormProps {
  defaultInvoiceNumber: string
  onSubmit: (values: {
    invoiceNumber: string
    date: string
    clientName?: string
    clientPhone?: string
    items: InvoiceItem[]
    subtotal: number
    taxAmount: number
    total: number
    paymentMethod: PaymentMethodCode
    paymentStatus: InvoicePaymentStatus
  }) => void
}

function InvoiceForm({ defaultInvoiceNumber, onSubmit }: InvoiceFormProps) {
  const [invoiceNumber, setInvoiceNumber] = useState(defaultInvoiceNumber)
  const [date, setDate] = useState(todayISO())
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [items, setItems] = useState<InvoiceItem[]>([
    {
      id: `item-0`,
      label: '',
      quantity: 1,
      unitPrice: 0,
      amount: 0,
    },
  ])
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodCode>('cash')
  const [paymentStatus, setPaymentStatus] = useState<InvoicePaymentStatus>('pending')
  const [error, setError] = useState<string | null>(null)

  const subtotal = items.reduce((sum, it) => sum + it.amount, 0)
  const total = subtotal

  const updateItemAmount = (index: number) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== index) return it
        const amount = Math.round((it.quantity ?? 0) * (it.unitPrice ?? 0))
        return { ...it, amount }
      }),
    )
  }

  const addItem = () => {
    setItems([
      ...items,
      {
        id: `item-${Date.now()}`,
        label: '',
        quantity: 1,
        unitPrice: 0,
        amount: 0,
      },
    ])
  }

  const removeItem = (index: number) => {
    if (items.length <= 1) return
    setItems(items.filter((_, i) => i !== index))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!invoiceNumber.trim()) {
      setError('Le numéro de facture est requis.')
      return
    }
    if (items.length === 0 || items.every((it) => !it.label.trim())) {
      setError('Au moins une ligne de facture est requise.')
      return
    }
    if (total <= 0) {
      setError('Le total doit être supérieur à zéro.')
      return
    }
    onSubmit({
      invoiceNumber: invoiceNumber.trim(),
      date,
      clientName: clientName.trim() || undefined,
      clientPhone: clientPhone.trim() || undefined,
      items: items.filter((it) => it.label.trim()),
      subtotal,
      taxAmount: 0,
      total,
      paymentMethod,
      paymentStatus,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <FieldGroup>
        <FieldLabel>Numéro de facture</FieldLabel>
        <Input
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
          required
        />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Date</FieldLabel>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Client (nom)</FieldLabel>
        <Input
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          placeholder="Nom du client"
        />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Téléphone</FieldLabel>
        <Input
          value={clientPhone}
          onChange={(e) => setClientPhone(e.target.value)}
          placeholder="Téléphone"
        />
      </FieldGroup>

      <div className="border rounded-lg p-3">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium">Lignes de facture</span>
          <Button size="sm" onClick={addItem}>
            <Plus size={14} className="mr-1" />
            Ajouter une ligne
          </Button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left pb-2 text-muted-foreground">Désignation</th>
              <th className="text-right pb-2 text-muted-foreground w-16">Qté</th>
              <th className="text-right pb-2 text-muted-foreground w-20">
                Prix unitaire
              </th>
              <th className="text-right pb-2 text-muted-foreground w-24">Montant</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} className="border-b">
                <td className="py-2">
                  <Input
                    value={item.label}
                    onChange={(e) => {
                      const next = { ...item, label: e.target.value }
                      setItems((prev) =>
                        prev.map((it, i) => (i === index ? next : it)),
                      )
                    }}
                    placeholder="Désignation"
                    className="h-8 text-sm"
                  />
                </td>
                <td className="py-2 text-right">
                  <Input
                    type="number"
                    value={item.quantity ?? 0}
                    onChange={(e) => {
                      const next = { ...item, quantity: Number(e.target.value) || 0 }
                      setItems((prev) =>
                        prev.map((it, i) => (i === index ? next : it)),
                      )
                      updateItemAmount(index)
                    }}
                    className="h-8 text-sm text-right"
                  />
                </td>
                <td className="py-2 text-right">
                  <Input
                    type="number"
                    value={item.unitPrice ?? 0}
                    onChange={(e) => {
                      const next = { ...item, unitPrice: Number(e.target.value) || 0 }
                      setItems((prev) =>
                        prev.map((it, i) => (i === index ? next : it)),
                      )
                      updateItemAmount(index)
                    }}
                    className="h-8 text-sm text-right"
                  />
                </td>
                <td className="py-2 text-right font-mono">
                  {formatFCFA(item.amount)}
                </td>
                <td className="py-2 text-right">
                  {items.length > 1 && (
                    <Button size="sm" variant="outline" onClick={() => removeItem(index)}>
                      <X size={14} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FieldGroup>
        <FieldLabel>Mode de paiement</FieldLabel>
        <Select
          value={paymentMethod}
          onValueChange={(v) => setPaymentMethod(v as PaymentMethodCode)}
        >
          <SelectTrigger>
            <SelectValue placeholder={paymentMethodLabel(paymentMethod)} />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {paymentMethodLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Statut de paiement</FieldLabel>
        <Select
          value={paymentStatus}
          onValueChange={(v) => setPaymentStatus(v as InvoicePaymentStatus)}
        >
          <SelectTrigger>
            <SelectValue placeholder={paymentStatusLabel(paymentStatus)} />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {paymentStatusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldGroup>

      <div className="pt-4 flex justify-between">
        <p className="text-sm text-muted-foreground">
          Total : <span className="font-medium">{formatFCFA(total)}</span>
        </p>
        <Button type="submit" className="bg-primary text-primary-foreground">
          Enregistrer la facture
        </Button>
      </div>
    </form>
  )
}
