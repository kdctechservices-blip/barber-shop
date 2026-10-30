import {
  Calendar,
  Users,
  X,
  Plus,
  RefreshCw,
  List,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAuth, useFieldAuth } from '../../contexts/authContext'
import { useSalonStore } from '../../hooks/salonStoreContext'
import { useToast } from '../../hooks/toastContext'
import { sendNotification } from '../../lib/notificationClient'
import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  Client,
} from '../../domain/models'
import { formatDateFR, formatDateTimeFR, formatFCFA, todayISO } from '../../utils/format'

const TIME_SLOTS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30',
]

const STATUS_BADGE: Record<AppointmentStatus, string> = {
  pending: 'secondary',
  confirmed: 'success-light',
  completed: 'outline',
  cancelled: 'destructive-light',
  no_show: 'destructive-light',
}

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'En attente',
  confirmed: 'Confirmé',
  completed: 'Terminé',
  cancelled: 'Annulé',
  no_show: 'Non présent',
}

export function AppointmentsPage() {
  const { state, mutate } = useSalonStore()
  const { currentUser } = useAuth()
  const isManager = currentUser?.role !== 'cashier'
  const fieldAuth = useFieldAuth({ screen: 'appointments' })
  const toast = useToast()

  const [selectedDate, setSelectedDate] = useState<string>(todayISO())
  const [view, setView] = useState<'day' | 'week' | 'list'>('day')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Appointment | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Appointment | null>(null)
  const [busy, setBusy] = useState(false)

  const [clientId, setClientId] = useState('')
  const [clientName, setClientName] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [serviceName, setServiceName] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [employeeName, setEmployeeName] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState<AppointmentStatus>('pending')
  const [source, setSource] = useState<AppointmentSource>('walkin')
  const [note, setNote] = useState('')
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid' | 'partial' | 'refunded'>('pending')

  const clients = useMemo(() => state.clients.filter((c) => c.isActive), [state.clients])
  const services = useMemo(() => state.services.filter((s) => s.isActive), [state.services])
  const employees = useMemo(() => state.employees.filter((e) => e.isActive), [state.employees])

  const dayStart = `${selectedDate}T00:00:00`
  const dayEnd = `${selectedDate}T23:59:59`

  const dayAppointments = useMemo(() => {
    return state.appointments.filter(
      (a) => a.startAt >= dayStart && a.startAt <= dayEnd,
    ).sort((a, b) => a.startAt.localeCompare(b.startAt))
  }, [state.appointments, dayStart, dayEnd])

  const weekStart = useMemo(() => {
    const d = new Date(selectedDate)
    const day = d.getDay()
    const diff = d.getDate() - day
    return new Date(d.setDate(diff))
  }, [selectedDate])

  const weekDays = useMemo(() => {
    const days: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart)
      d.setDate(d.getDate() + i)
      days.push(d.toISOString().slice(0, 10))
    }
    return days
  }, [weekStart])

  const weekAppointments = useMemo(() => {
    const start = `${weekStart.toISOString().slice(0, 10)}T00:00:00`
    const end = `${weekStart.toISOString().slice(0, 10)}T23:59:59`
    // Simple: return appointments for the 7 days
    return state.appointments.filter(
      (a) => a.startAt >= start && a.startAt <= end,
    ).sort((a, b) => a.startAt.localeCompare(b.startAt))
  }, [state.appointments, weekStart])

  const openCreate = () => {
    setEditing(null)
    setClientId('')
    setClientName('')
    setServiceId('')
    setServiceName('')
    setEmployeeId('')
    setEmployeeName('')
    setStartAt(`${selectedDate}T09:00`)
    setEndAt(`${selectedDate}T09:30`)
    setAmount('')
    setStatus('pending')
    setSource('walkin')
    setNote('')
    setPaymentStatus('pending')
    setFormOpen(true)
  }

  const openEdit = (appt: Appointment) => {
    setEditing(appt)
    setClientId(appt.clientId)
    setClientName(appt.clientName)
    setServiceId(appt.serviceId)
    setServiceName(appt.serviceName)
    setEmployeeId(appt.employeeId ?? '')
    setEmployeeName(appt.employeeName ?? '')
    setStartAt(appt.startAt)
    setEndAt(appt.endAt)
    setStatus(appt.status)
    setSource(appt.source)
    setAmount(String(appt.amount))
    setNote(appt.note ?? '')
    setPaymentStatus(appt.paymentStatus)
    setFormOpen(true)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const client = clients.find((c) => c.id === clientId) ?? {
        fullName: clientName,
        phone: undefined,
      } as Client

      if (editing) {
        await mutate((repo) =>
          repo.saveAppointment({
            id: editing.id,
            clientId,
            clientName: clientName.trim(),
            serviceId,
            serviceName: serviceName.trim(),
            employeeId: employeeId || undefined,
            employeeName: employeeName?.trim() || undefined,
            startAt,
            endAt,
            status,
            source,
            amount: Number(amount) || 0,
            paymentStatus,
            note,
          }),
        )
        toast.success('Rendez-vous mis à jour.')
      } else {
        await mutate((repo) =>
          repo.saveAppointment({
            clientId,
            clientName: clientName.trim(),
            serviceId,
            serviceName: serviceName.trim(),
            employeeId: employeeId || undefined,
            employeeName: employeeName?.trim() || undefined,
            startAt,
            endAt,
            status,
            source,
            amount: Number(amount) || 0,
            paymentStatus,
            note,
          }),
        )
        // Envoyer une notification de confirmation (best-effort)
        try {
          await sendNotification({
            type: 'appointment_confirmation',
            channel: 'sms',
            to: client.phone ?? '',
            clientName: client.fullName,
            variables: {
              clientName: client.fullName,
              salonName: state.salon.name,
              appointmentDate: formatDateFR(startAt.slice(0, 10), 'long-fr'),
              appointmentTime: startAt.slice(11, 16),
            },
          })
        } catch {
          // Notification best-effort, ne fait pas échouer la création
        }
        toast.success('Rendez-vous créé.')
      }
      setFormOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur rendez-vous.')
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatus = async (appt: Appointment, nextStatus: AppointmentStatus) => {
    setBusy(true)
    try {
      await mutate((repo) => repo.updateAppointmentStatus(appt.id, nextStatus))
      toast.success(`Statut mis à jour : ${STATUS_LABEL[nextStatus]}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec mise à jour statut.')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await mutate((repo) => repo.deleteAppointment(deleteTarget!.id))
      setDeleteTarget(null)
      toast.success('Rendez-vous supprimé.')
    } catch (err) {
      setDeleteTarget(null)
      toast.error(err instanceof Error ? err.message : 'Suppression refusée.')
    } finally {
      setBusy(false)
    }
  }

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.fullName }))
  const serviceOptions = services.map((s) => ({ value: s.id, label: s.name }))
  const employeeOptions = employees.map((e) => ({ value: e.id, label: e.fullName }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header no-print">
        <div>
          <h1 className="page-title">Agenda &amp; Rendez-vous</h1>
          <p className="page-subtitle">
            Gestion des rendez-vous clients, planning du personnel et
            réservation en ligne
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Button type="button" variant="outline" size="xs" onClick={() => setView('day')}>
            <Calendar size={14} /> Jour
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => setView('week')}>
            <Calendar size={14} /> Semaine
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => setView('list')}>
            <List size={14} /> Liste
          </Button>
          {isManager && (
            <Button type="button" onClick={openCreate}>
              <Plus size={15} />
              Nouveau rendez-vous
            </Button>
          )}
        </div>
      </div>

      {/* Sélecteur de date */}
      <div
        className="surface-card no-print"
        style={{ padding: '12px 16px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <FieldLabel>Date</FieldLabel>
        <Input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          disabled={view !== 'day'}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSelectedDate(todayISO())}
        >
          <RefreshCw size={14} /> Aujourd'hui
        </Button>
        {view === 'week' && (
          <span className="text-muted-foreground text-sm">
            Du {formatDateFR(weekDays[0], 'long-fr')} au{' '}
            {formatDateFR(weekDays[6], 'long-fr')}
          </span>
        )}
      </div>

      {/* Vue Liste / Jour */}
      <Card>
        <CardContent style={{ paddingTop: 6 }}>
          {dayAppointments.length === 0 && weekAppointments.length === 0 ? (
            <EmptyState
              icon={<Calendar size={24} />}
              title="Aucun rendez-vous"
              description={
                view === 'list'
                  ? 'Aucun rendez-vous planifié.'
                  : `Aucun rendez-vous le ${formatDateFR(selectedDate, 'long-fr')}.`
              }
              actionLabel={isManager ? 'Créer un rendez-vous' : undefined}
              onAction={isManager ? openCreate : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Heure</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Prestation</TableHead>
                  <TableHead>Employé</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="text-right">Montant</TableHead>
                  <TableHead className="text-right no-print">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(view === 'week' ? weekAppointments : dayAppointments).map((appt) => {
                  const apptDate = new Date(appt.startAt)
                  const timeStr = apptDate.toLocaleTimeString('fr-FR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                  const client = clients.find((c) => c.id === appt.clientId)
                  const service = services.find((s) => s.id === appt.serviceId)
                  const emp = employees.find((e) => e.id === appt.employeeId)

                  return (
                    <TableRow key={appt.id}>
                      <TableCell>
                        <span className="text-sm font-medium">{timeStr}</span>
                        <br />
                        <span className="text-xs text-muted-foreground">
                          {formatDateFR(appt.startAt.slice(0, 10))}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">
                            {appt.clientName}
                          </span>
                          {client?.phone && (
                            <span className="text-xs text-muted-foreground">
                              {client.phone}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">
                          {appt.serviceName}
                        </span>
                        {service && (
                          <span className="text-xs text-muted-foreground">
                            {formatFCFA(service.referencePrice)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">
                          {emp?.fullName || appt.employeeName || '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE[appt.status] as any} size="sm">
                          {STATUS_LABEL[appt.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums font-medium">
                          {formatFCFA(appt.amount)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right no-print">
                        <div className="inline-flex items-center justify-end gap-1">
                          <Select
                            value={appt.status}
                            onValueChange={(v) =>
                              handleToggleStatus(appt, v as AppointmentStatus)
                            }
                            disabled={!fieldAuth.canWrite('status')}
                          >
                            <SelectTrigger className="h-7 w-32 p-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] as const).map((s) => (
                                <SelectItem key={s} value={s}>
                                  {STATUS_LABEL[s]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {isManager && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title="Modifier"
                                onClick={() => openEdit(appt)}
                              >
                                <Users className="size-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                style={{ color: 'var(--color-danger)' }}
                                title="Supprimer"
                                onClick={() => setDeleteTarget(appt)}
                              >
                                <X size={14} />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Créneaux disponibles (vue jour) */}
      {view === 'day' && dayAppointments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Créneaux de la journée</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {TIME_SLOTS.map((slot) => {
                const slotStart = `${selectedDate}T${slot}`
                const existing = dayAppointments.find(
                  (a) => a.startAt === slotStart || (a.startAt < slotStart && a.endAt > slotStart),
                )
                const isTaken = Boolean(existing)
                return (
                  <Button
                    key={slot}
                    type="button"
                    variant={isTaken ? 'destructive' : 'outline'}
                    size="sm"
                    disabled={isTaken}
                    onClick={isTaken ? undefined : () => {
                      setStartAt(slotStart)
                      const [h, m] = slot.split(':')
                      const endMin = (Number(m) + 30) % 60
                      const endH = Number(h) + (Number(m) + 30 >= 60 ? 1 : 0)
                      setEndAt(`${selectedDate}T${String(endH).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`)
                      if (!editing) openCreate()
                    }}
                  >
                    {slot}
                    {isTaken && <span className="ml-1 text-xs opacity-60">Occupé</span>}
                  </Button>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modale Création / Édition */}
      <Modal
        open={formOpen}
        title={editing ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous'}
        subtitle="Sélectionnez le client, la prestation, l’employé et l’horaire."
        maxWidth={640}
        onClose={() => setFormOpen(false)}
      >
        <form className="w-full" onSubmit={(e) => void handleSubmit(e)}>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="f-appt-client">Client</FieldLabel>
                <Select
                  value={clientId}
                  onValueChange={(v) => {
                    setClientId(v)
                    const c = clients.find((x) => x.id === v)
                    setClientName(c?.fullName ?? '')
                  }}
                >
                  <SelectTrigger id="f-appt-client">
                    <SelectValue placeholder="Choisir un client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clientOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="f-appt-service">Prestation</FieldLabel>
                <Select
                  value={serviceId}
                  onValueChange={(v) => {
                    setServiceId(v)
                    const s = services.find((x) => x.id === v)
                    setServiceName(s?.name ?? '')
                    setAmount(s?.referencePrice?.toString() ?? '')
                  }}
                >
                  <SelectTrigger id="f-appt-service">
                    <SelectValue placeholder="Choisir une prestation" />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="f-appt-employee">Employé (optionnel)</FieldLabel>
                <Select
                  value={employeeId}
                  onValueChange={(v) => {
                    setEmployeeId(v)
                    const e = employees.find((x) => x.id === v)
                    setEmployeeName(e?.fullName ?? '')
                  }}
                >
                  <SelectTrigger id="f-appt-employee">
                    <SelectValue placeholder="Aucun employé attribué" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Aucun</SelectItem>
                    {employeeOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="f-appt-source">Origine</FieldLabel>
                <Select
                  value={source}
                  onValueChange={(v) => setSource(v as AppointmentSource)}
                  disabled={!fieldAuth.canWrite('source')}
                >
                  <SelectTrigger id="f-appt-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="walkin">Client en salon</SelectItem>
                    <SelectItem value="booking">Réservation en ligne</SelectItem>
                    <SelectItem value="phone">Par téléphone</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="f-appt-start">Début</FieldLabel>
                <Input
                  id="f-appt-start"
                  type="datetime-local"
                  required
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  disabled={!fieldAuth.canWrite('startAt')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="f-appt-end">Fin</FieldLabel>
                <Input
                  id="f-appt-end"
                  type="datetime-local"
                  required
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  disabled={!fieldAuth.canWrite('endAt')}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="f-appt-amount">Montant (FCFA)</FieldLabel>
                <Input
                  id="f-appt-amount"
                  type="number"
                  min={0}
                  step={1}
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={!fieldAuth.canWrite('amount')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="f-appt-payment">Paiement</FieldLabel>
                <Select
                  value={paymentStatus}
                  onValueChange={(v) => setPaymentStatus(v as 'pending' | 'paid' | 'partial' | 'refunded')}
                  disabled={!fieldAuth.canWrite('paymentStatus')}
                >
                  <SelectTrigger id="f-appt-payment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">En attente</SelectItem>
                    <SelectItem value="paid">Payé</SelectItem>
                    <SelectItem value="partial">Partiel</SelectItem>
                    <SelectItem value="refunded">Remboursé</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="f-appt-status">Statut</FieldLabel>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as AppointmentStatus)}
                  disabled={!fieldAuth.canWrite('status')}
                >
                  <SelectTrigger id="f-appt-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] as const).map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="f-appt-note">Note (optionnel)</FieldLabel>
                <Input
                  id="f-appt-note"
                  type="text"
                  placeholder="Ex. Allergie aux produits, préférence coiffeur..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={!fieldAuth.canWrite('note')}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormOpen(false)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                {editing ? 'Enregistrer' : 'Créer le rendez-vous'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </Modal>

      {/* Confirmation suppression */}
      {deleteTarget && (
        <ConfirmDialog
          open={true}
          onCancel={() => setDeleteTarget(null)}
          title="Supprimer ce rendez-vous ?"
          message={`Le rendez-vous de ${deleteTarget.clientName} le ${formatDateTimeFR(deleteTarget.startAt)} sera définitivement supprimé.`}
          confirmLabel="Supprimer"
          onConfirm={() => {
            void handleDelete()
            setDeleteTarget(null)
          }}
        />
      )}
    </div>
  )
}
