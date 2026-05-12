import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useAction, useMutation, useQuery } from 'convex/react'
import { PlusIcon, SearchIcon, Trash2Icon, UploadIcon } from 'lucide-react'

import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const sessionStorageKey = 'partchaos.session'
const rowHeight = 56
const defaultTableHeight = 520

type InventoryItem = {
  _id: Id<'items'>
  sku: string
  location: string
}

type ProductDraft = {
  id: string
  sku: string
  location: string
}

type ProductField = 'sku' | 'location'
type AddProductsStep = 'upload' | 'processing' | 'select' | 'edit'
type FillSelection = {
  sourceId: string
  targetId: string
  field: ProductField
  value: string
}

const productFields: ProductField[] = ['sku', 'location']

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function createEmptyDraft(): ProductDraft {
  return {
    id: crypto.randomUUID(),
    sku: '',
    location: '',
  }
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Could not read the PDF file.'))
      }
    })
    reader.addEventListener('error', () => reject(new Error('Could not read the PDF file.')))
    reader.readAsDataURL(file)
  })
}

function fuzzyMatch(value: string, query: string) {
  const normalizedValue = value.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  let queryIndex = 0

  if (!normalizedQuery) {
    return true
  }

  for (const char of normalizedValue) {
    if (char === normalizedQuery[queryIndex]) {
      queryIndex += 1
    }

    if (queryIndex === normalizedQuery.length) {
      return true
    }
  }

  return false
}

function hydrateSkuFromExisting(
  draft: ProductDraft,
  existingBySku: Map<string, InventoryItem>,
): ProductDraft {
  const existing = existingBySku.get(draft.sku.trim().toLowerCase())

  if (!existing) {
    return draft
  }

  return {
    ...draft,
    sku: existing.sku,
    location: existing.location,
  }
}

function applySkuPrefix(sku: string, prefix: string) {
  const trimmedSku = sku.trim()
  const trimmedPrefix = prefix.trim()

  if (!trimmedSku || !trimmedPrefix) {
    return trimmedSku
  }

  const prefixWithSeparator = `${trimmedPrefix}-`
  return trimmedSku.toLowerCase().startsWith(prefixWithSeparator.toLowerCase())
    ? trimmedSku
    : `${prefixWithSeparator}${trimmedSku}`
}

function App() {
  const [password, setPassword] = useState('')
  const [sessionToken, setSessionToken] = useState(() =>
    window.localStorage.getItem(sessionStorageKey),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  const passkeyStatus = useQuery(api.auth.passkeyStatus)
  const sessionStatus = useQuery(
    api.auth.sessionStatus,
    sessionToken ? { sessionToken } : { sessionToken: undefined },
  )
  const isAuthenticated = Boolean(sessionToken && sessionStatus?.authenticated)
  const items = useQuery(
    api.items.list,
    isAuthenticated && sessionToken ? { sessionToken } : 'skip',
  )

  const beginRegistration = useAction(api.passkeys.startRegistration)
  const completeRegistration = useAction(api.passkeys.finishRegistration)
  const beginAuthentication = useAction(api.passkeys.startAuthentication)
  const completeAuthentication = useAction(api.passkeys.finishAuthentication)
  const scanPurchaseOrder = useAction(api.pdfScan.scanPurchaseOrder)
  const upsertItems = useMutation(api.items.upsertMany)
  const removeItem = useMutation(api.items.remove)

  useEffect(() => {
    if (sessionToken && sessionStatus && !sessionStatus.authenticated) {
      window.localStorage.removeItem(sessionStorageKey)
    }
  }, [sessionStatus, sessionToken])

  const inventoryItems = useMemo(() => (items ?? []) as InventoryItem[], [items])
  const filteredItems = useMemo(() => {
    const query = search.trim()

    if (!query) {
      return inventoryItems
    }

    return inventoryItems.filter((item) => fuzzyMatch(`${item.sku} ${item.location}`, query))
  }, [inventoryItems, search])

  async function handleCreatePasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy('create-passkey')
    setMessage(null)

    try {
      const registration = await beginRegistration({
        password,
        origin: window.location.origin,
      })
      const response = await startRegistration({ optionsJSON: registration.options })

      await completeRegistration({
        challenge: registration.challenge,
        response,
      })

      setPassword('')
      setMessage('Passkey created. You can now sign in without the universal password.')
    } catch (error) {
      setMessage(messageFromError(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleSignIn() {
    setBusy('sign-in')
    setMessage(null)

    try {
      const authentication = await beginAuthentication({ origin: window.location.origin })
      const response = await startAuthentication({ optionsJSON: authentication.options })
      const session = await completeAuthentication({
        challenge: authentication.challenge,
        response,
      })

      window.localStorage.setItem(sessionStorageKey, session.sessionToken)
      setSessionToken(session.sessionToken)
      setMessage('Signed in with passkey.')
    } catch (error) {
      setMessage(messageFromError(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleRemoveItem(id: Id<'items'>) {
    if (!sessionToken) {
      setMessage('Sign in first.')
      return
    }

    setBusy(id)
    setMessage(null)

    try {
      await removeItem({ sessionToken, id })
    } catch (error) {
      setMessage(messageFromError(error))
    } finally {
      setBusy(null)
    }
  }

  function handleSignOut() {
    window.localStorage.removeItem(sessionStorageKey)
    setSessionToken(null)
    setMessage('Signed out.')
  }

  async function handleSaveProducts(products: ProductDraft[]) {
    if (!sessionToken) {
      setMessage('Sign in first.')
      return
    }

    setBusy('save-products')
    setMessage(null)

    try {
      await upsertItems({
        sessionToken,
        products: products.map(({ sku, location }) => ({ sku, location })),
      })
      setAddDialogOpen(false)
      setMessage('Inventory updated.')
    } catch (error) {
      setMessage(messageFromError(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleScanPurchaseOrder(file: File) {
    if (!sessionToken) {
      throw new Error('Sign in first.')
    }

    const fileDataUrl = await fileToDataUrl(file)
    const result = await scanPurchaseOrder({
      sessionToken,
      fileName: file.name,
      fileDataUrl,
    })

    return result.products.map((product) => ({
      id: crypto.randomUUID(),
      sku: product.sku,
      location: product.location,
    }))
  }

  if (!isAuthenticated) {
    return (
      <LoginScreen
        busy={busy}
        message={message}
        passkeyCount={passkeyStatus?.passkeyCount ?? 0}
        hasPasskey={Boolean(passkeyStatus?.hasPasskey)}
        password={password}
        checkingSession={Boolean(sessionToken && sessionStatus === undefined)}
        onPasswordChange={setPassword}
        onCreatePasskey={handleCreatePasskey}
        onSignIn={handleSignIn}
      />
    )
  }

  return (
    <main className="mx-auto flex h-screen w-full max-w-6xl flex-col gap-6 overflow-hidden px-4 pt-8 pb-4">
      <header className="shrink-0 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">partchaos</p>
          <h1 className="text-4xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Search, import, edit, and remove product records by SKU.
          </p>
        </div>
        <div className="flex gap-2">
          <AddProductsDialog
            open={addDialogOpen}
            existingItems={inventoryItems}
            saving={busy === 'save-products'}
            onOpenChange={setAddDialogOpen}
            onScan={handleScanPurchaseOrder}
            onSave={handleSaveProducts}
          />
          <Button type="button" variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      {message ? (
        <Card className="shrink-0">
          <CardContent className="text-sm">{message}</CardContent>
        </Card>
      ) : null}

      <Card className="min-h-0 w-full min-w-0 flex-1 basis-0 pb-0">
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <CardTitle>Products</CardTitle>
              <CardDescription>
                {items === undefined
                  ? 'Loading inventory...'
                  : `${filteredItems.length} of ${inventoryItems.length} products`}
              </CardDescription>
            </div>
            <div className="relative w-full sm:max-w-sm">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Fuzzy search SKU or location"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 basis-0 flex-col pb-6">
          {items === undefined ? (
            <p className="text-muted-foreground flex flex-1 items-center justify-center rounded-md border p-6 text-center text-sm">
              Loading products...
            </p>
          ) : (
            <InventoryTable
              items={filteredItems}
              removingId={busy}
              onRemove={handleRemoveItem}
            />
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function LoginScreen({
  busy,
  message,
  passkeyCount,
  hasPasskey,
  password,
  checkingSession,
  onPasswordChange,
  onCreatePasskey,
  onSignIn,
}: {
  busy: string | null
  message: string | null
  passkeyCount: number
  hasPasskey: boolean
  password: string
  checkingSession: boolean
  onPasswordChange: (password: string) => void
  onCreatePasskey: (event: FormEvent<HTMLFormElement>) => void
  onSignIn: () => void
}) {
  return (
    <main className="bg-muted/30 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <section className="space-y-2 text-center">
          <p className="text-muted-foreground text-sm">partchaos</p>
          <h1 className="text-3xl font-semibold tracking-tight">Sign in to inventory</h1>
          <p className="text-muted-foreground text-sm">
            Authenticate with a passkey before accessing product data.
          </p>
        </section>

        {message ? (
          <Card>
            <CardContent className="text-sm">{message}</CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>
              {passkeyCount} global passkey{passkeyCount === 1 ? '' : 's'} registered.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              className="w-full"
              onClick={onSignIn}
              disabled={!hasPasskey || busy === 'sign-in' || checkingSession}
            >
              {busy === 'sign-in'
                ? 'Opening passkey...'
                : checkingSession
                  ? 'Checking session...'
                  : 'Sign in with passkey'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create Passkey</CardTitle>
            <CardDescription>
              Use the universal password to create a passkey for this shared app.
            </CardDescription>
          </CardHeader>
          <form onSubmit={onCreatePasskey}>
            <CardContent className="space-y-3">
              <Label htmlFor="password">Universal password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                autoComplete="current-password"
              />
            </CardContent>
            <CardFooter>
              <Button className="w-full" type="submit" disabled={!password || busy === 'create-passkey'}>
                {busy === 'create-passkey' ? 'Creating...' : 'Create passkey'}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </main>
  )
}

function InventoryTable({
  items,
  removingId,
  onRemove,
}: {
  items: InventoryItem[]
  removingId: string | null
  onRemove: (id: Id<'items'>) => void
}) {
  const [scrollTop, setScrollTop] = useState(0)
  const [tableViewportHeight, setTableViewportHeight] = useState(defaultTableHeight)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  const visibleCount = Math.ceil(tableViewportHeight / rowHeight) + 8
  const visibleItems = items.slice(startIndex, startIndex + visibleCount)
  const totalRowsHeight = items.length * rowHeight
  const virtualTableHeight = Math.max(totalRowsHeight, tableViewportHeight)

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current

    if (!scrollContainer) {
      return
    }

    const updateTableHeight = () => {
      setTableViewportHeight(Math.max(scrollContainer.clientHeight, rowHeight))
    }

    updateTableHeight()

    const observer = new ResizeObserver(updateTableHeight)
    observer.observe(scrollContainer)

    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 basis-0 flex-col overflow-hidden rounded-md border">
      <div className="bg-muted/50 grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_3rem] border-b px-4 py-3 text-sm font-medium">
        <div>SKU</div>
        <div>Location</div>
        <div className="sr-only">Remove</div>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center text-sm">
          No products found.
        </p>
      ) : (
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: virtualTableHeight, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                left: 0,
                transform: `translateY(${startIndex * rowHeight}px)`,
              }}
            >
              {visibleItems.map((item) => (
                <div
                  key={item._id}
                  className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_3rem] items-center border-b px-4 text-sm last:border-b-0"
                  style={{ height: rowHeight }}
                >
                  <div className="min-w-0 truncate font-medium">{item.sku}</div>
                  <div className="text-muted-foreground min-w-0 truncate">{item.location || '-'}</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${item.sku}`}
                    onClick={() => onRemove(item._id)}
                    disabled={removingId === item._id}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AddProductsDialog({
  open,
  existingItems,
  saving,
  onOpenChange,
  onScan,
  onSave,
}: {
  open: boolean
  existingItems: InventoryItem[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onScan: (file: File) => Promise<ProductDraft[]>
  onSave: (products: ProductDraft[]) => Promise<void>
}) {
  const [step, setStep] = useState<AddProductsStep>('upload')
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [brandPrefix, setBrandPrefix] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<ProductDraft[]>([createEmptyDraft()])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [fillSelection, setFillSelection] = useState<FillSelection | null>(null)
  const activeScanId = useRef(0)
  const existingBySku = useMemo(
    () => new Map(existingItems.map((item) => [item.sku.toLowerCase(), item])),
    [existingItems],
  )
  const allSelected = drafts.length > 0 && selectedIds.size === drafts.length
  const selectedDrafts = drafts.filter((draft) => selectedIds.has(draft.id))
  const saveableDrafts = selectedDrafts.filter((draft) => draft.sku.trim())
  const fillRange = useMemo(() => {
    if (!fillSelection) {
      return null
    }

    const sourceIndex = drafts.findIndex((draft) => draft.id === fillSelection.sourceId)
    const targetIndex = drafts.findIndex((draft) => draft.id === fillSelection.targetId)

    if (sourceIndex === -1 || targetIndex === -1) {
      return null
    }

    return {
      start: Math.min(sourceIndex, targetIndex),
      end: Math.max(sourceIndex, targetIndex),
      field: fillSelection.field,
    }
  }, [drafts, fillSelection])

  useEffect(() => {
    if (!fillSelection) {
      return
    }

    const selection = fillSelection

    function finishFillSelection() {
      setDrafts((currentDrafts) => {
        const sourceIndex = currentDrafts.findIndex((currentDraft) => currentDraft.id === selection.sourceId)
        const targetIndex = currentDrafts.findIndex((currentDraft) => currentDraft.id === selection.targetId)

        if (sourceIndex === -1 || targetIndex === -1) {
          return currentDrafts
        }

        const start = Math.min(sourceIndex, targetIndex)
        const end = Math.max(sourceIndex, targetIndex)

        return currentDrafts.map((draft, index) => {
          if (index < start || index > end) {
            return draft
          }

          const updatedDraft = { ...draft, [selection.field]: selection.value }
          return selection.field === 'sku'
            ? hydrateSkuFromExisting(updatedDraft, existingBySku)
            : updatedDraft
        })
      })
      setFillSelection(null)
    }

    window.addEventListener('pointerup', finishFillSelection)
    return () => window.removeEventListener('pointerup', finishFillSelection)
  }, [existingBySku, fillSelection])

  function resetDraftState() {
    setStep('upload')
    setPdfFile(null)
    setBrandPrefix('')
    setScanning(false)
    setScanError(null)
    setDrafts([createEmptyDraft()])
    setSelectedIds(new Set())
    setFillSelection(null)
    activeScanId.current += 1
  }

  function resetDialog(nextOpen: boolean) {
    if (nextOpen) {
      resetDraftState()
    }

    onOpenChange(nextOpen)

    if (!nextOpen) {
      resetDraftState()
    }
  }

  function handlePdfFileChange(file: File | null) {
    setPdfFile(file)
    setScanError(null)
    setDrafts([])
    setSelectedIds(new Set())

    if (!file) {
      setStep('upload')
      return
    }

    setStep('processing')
    startPdfScan(file)
  }

  function startManualEntry() {
    const draft = createEmptyDraft()

    setPdfFile(null)
    setScanError(null)
    setDrafts([draft])
    setSelectedIds(new Set([draft.id]))
    setStep('edit')
  }

  async function startPdfScan(file: File) {
    const scanId = activeScanId.current + 1

    activeScanId.current = scanId
    setScanning(true)
    setScanError(null)

    try {
      const parsedDrafts = await onScan(file)

      if (activeScanId.current !== scanId) {
        return
      }

      const hydratedDrafts = parsedDrafts.map((draft) => hydrateSkuFromExisting(draft, existingBySku))

      setDrafts(hydratedDrafts.length > 0 ? hydratedDrafts : [createEmptyDraft()])
      setSelectedIds(new Set(hydratedDrafts.map((draft) => draft.id)))
      setStep('select')
    } catch (error) {
      if (activeScanId.current === scanId) {
        setScanError(messageFromError(error))
      }
    } finally {
      if (activeScanId.current === scanId) {
        setScanning(false)
      }
    }
  }

  function updateDraft(id: string, field: ProductField, value: string) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) => {
        if (draft.id !== id) {
          return draft
        }

        const updatedDraft = { ...draft, [field]: value }
        return field === 'sku' ? hydrateSkuFromExisting(updatedDraft, existingBySku) : updatedDraft
      }),
    )
  }

  function applyBrandPrefix(draft: ProductDraft) {
    const sku = applySkuPrefix(draft.sku, brandPrefix)
    return hydrateSkuFromExisting({ ...draft, sku }, existingBySku)
  }

  function continueToEditSelectedProducts() {
    const keptDrafts = drafts.filter((draft) => selectedIds.has(draft.id)).map(applyBrandPrefix)

    setDrafts(keptDrafts)
    setSelectedIds(new Set(keptDrafts.map((draft) => draft.id)))
    setStep('edit')
  }

  function beginFillSelection(id: string, field: ProductField, value: string) {
    setFillSelection({
      sourceId: id,
      targetId: id,
      field,
      value,
    })
  }

  function updateFillSelectionTarget(id: string) {
    setFillSelection((current) => (current ? { ...current, targetId: id } : current))
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(drafts.map((draft) => draft.id)) : new Set())
  }

  function toggleDraft(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)

      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }

      return next
    })
  }

  function toggleDraftSelection(id: string) {
    toggleDraft(id, !selectedIds.has(id))
  }

  function addEditableRow() {
    const draft = createEmptyDraft()

    setDrafts((currentDrafts) => [...currentDrafts, draft])
    setSelectedIds((current) => new Set([...current, draft.id]))
  }

  function shouldToggleRow(target: EventTarget | null) {
    return target instanceof HTMLElement && !target.closest('button, input, [role="checkbox"]')
  }

  return (
    <Dialog open={open} onOpenChange={resetDialog}>
      <DialogTrigger asChild>
        <Button type="button">
          <PlusIcon className="size-4" />
          Add items
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add inventory items</DialogTitle>
          <DialogDescription>
            {step === 'upload'
              ? 'Start with a purchase order PDF or skip directly to manual entry.'
              : step === 'processing'
                ? 'The PDF is scanning in the background while you enter the brand prefix.'
                : step === 'select'
                  ? 'Choose the parsed products to keep before editing them.'
                  : 'Review selected products before saving.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' ? (
          <div className="space-y-6">
            <div className="border-muted-foreground/25 hover:bg-muted/40 rounded-lg border border-dashed p-8 text-center transition-colors">
              <UploadIcon className="text-muted-foreground mx-auto mb-3 size-8" />
              <Label htmlFor="purchase-order" className="mx-auto justify-center">
                Upload purchase order PDF
              </Label>
              <Input
                id="purchase-order"
                className="mx-auto mt-4 max-w-sm"
                type="file"
                accept="application/pdf"
                onChange={(event) => handlePdfFileChange(event.target.files?.[0] ?? null)}
              />
              <p className="text-muted-foreground mt-3 text-sm">
                Pick a purchase order PDF to scan it with AI, or skip to add rows manually.
              </p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" onClick={startManualEntry}>
                Skip upload
              </Button>
            </DialogFooter>
          </div>
        ) : step === 'processing' ? (
          <div className="space-y-6">
            <div className="space-y-4 rounded-lg border p-4">
              <div>
                <p className="text-sm font-medium">Processing PDF</p>
                <p className="text-muted-foreground text-sm">
                  {scanning
                    ? `${pdfFile?.name ?? 'Selected purchase order'} is being scanned for line item SKUs and part numbers.`
                    : `${pdfFile?.name ?? 'Selected purchase order'} has finished processing.`}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-order-brand-prefix">Brand prefix</Label>
                <Input
                  id="purchase-order-brand-prefix"
                  value={brandPrefix}
                  onChange={(event) => setBrandPrefix(event.target.value)}
                  placeholder="Prefix for every SKU"
                />
              </div>
              {scanError ? (
                <p className="text-destructive text-sm">{scanError}</p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  The prefix entered here will be prepended to each parsed SKU as PREFIX-SKU.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('upload')}
                disabled={scanning}
              >
                Back
              </Button>
              {scanError ? (
                <Button type="button" onClick={() => pdfFile && startPdfScan(pdfFile)} disabled={!pdfFile}>
                  Try again
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => setStep('select')}
                  disabled={!brandPrefix.trim() || scanning || drafts.length === 0}
                >
                  {scanning ? 'Scanning PDF...' : 'Review products'}
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : step === 'select' ? (
          <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div className="space-y-2 rounded-md border p-3">
              <Label htmlFor="review-purchase-order-brand-prefix">Brand prefix</Label>
              <Input
                id="review-purchase-order-brand-prefix"
                value={brandPrefix}
                onChange={(event) => setBrandPrefix(event.target.value)}
                placeholder="Prefix for every selected SKU"
              />
            </div>
            <div className="overflow-auto rounded-md border">
              <div className="bg-muted/50 grid min-w-[640px] grid-cols-[3rem_1.5fr_1fr] items-center border-b px-3 py-3 text-sm font-medium">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all parsed products"
                />
                <div>SKU</div>
                <div>Location</div>
              </div>
              <div className="max-h-[320px] min-w-[640px] overflow-y-auto">
                {drafts.map((draft) => {
                  const isSelected = selectedIds.has(draft.id)
                  const reviewDraft = applyBrandPrefix(draft)

                  return (
                    <div
                      key={draft.id}
                      className={`grid cursor-pointer grid-cols-[3rem_1.5fr_1fr] items-center gap-3 border-b px-3 py-3 text-sm last:border-b-0 ${
                        isSelected ? 'bg-primary/5' : 'hover:bg-muted/40'
                      }`}
                      onClick={(event) => {
                        if (shouldToggleRow(event.target)) {
                          toggleDraftSelection(draft.id)
                        }
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => toggleDraft(draft.id, checked === true)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Keep ${draft.sku || 'blank product row'}`}
                      />
                      <div className="truncate font-medium">{reviewDraft.sku || '-'}</div>
                      <div className="text-muted-foreground truncate">{reviewDraft.location || '-'}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep('processing')}>
                Back
              </Button>
              <Button
                type="button"
                disabled={selectedIds.size === 0 || !brandPrefix.trim()}
                onClick={continueToEditSelectedProducts}
              >
                Edit {selectedIds.size} selected
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div className="overflow-auto rounded-md border">
              <div className="bg-muted/50 grid min-w-[640px] grid-cols-[3rem_1.5fr_1fr] items-center border-b px-3 py-3 text-sm font-medium">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all products"
                />
                <div>SKU</div>
                <div>Location</div>
              </div>
              <div className="max-h-[320px] min-w-[640px] overflow-y-auto">
                {drafts.map((draft, rowIndex) => {
                  const isSelected = selectedIds.has(draft.id)

                  return (
                    <div
                      key={draft.id}
                      className={`grid cursor-pointer grid-cols-[3rem_1.5fr_1fr] items-center gap-3 border-b px-3 py-2 last:border-b-0 ${
                        isSelected ? 'bg-primary/5' : 'hover:bg-muted/40'
                      }`}
                      onClick={(event) => {
                        if (shouldToggleRow(event.target)) {
                          toggleDraftSelection(draft.id)
                        }
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => toggleDraft(draft.id, checked === true)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${draft.sku || 'blank product row'}`}
                      />
                      {productFields.map((field) => {
                        const isInFillRange =
                          fillRange?.field === field &&
                          rowIndex >= fillRange.start &&
                          rowIndex <= fillRange.end

                        return (
                          <div
                            key={field}
                            className={`relative rounded-md ${isInFillRange ? 'ring-primary ring-2' : ''}`}
                            onPointerEnter={() => updateFillSelectionTarget(draft.id)}
                          >
                            <Input
                              className="pr-6"
                              value={draft[field]}
                              onChange={(event) => updateDraft(draft.id, field, event.target.value)}
                              placeholder={field === 'sku' ? 'SKU' : 'Location'}
                            />
                            <button
                              type="button"
                              className="bg-primary absolute right-1.5 bottom-1.5 size-2 cursor-crosshair rounded-full opacity-70 transition-opacity hover:opacity-100"
                              aria-label={`Fill ${field} from this cell`}
                              onPointerDown={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                beginFillSelection(draft.id, field, draft[field])
                              }}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={addEditableRow}
              >
                <PlusIcon className="size-4" />
                Add row
              </Button>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(pdfFile ? 'select' : 'upload')}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={saveableDrafts.length === 0 || saving}
                  onClick={() => onSave(saveableDrafts)}
                >
                  {saving ? 'Saving...' : `Save ${saveableDrafts.length} selected`}
                </Button>
              </DialogFooter>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default App
