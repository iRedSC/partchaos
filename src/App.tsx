import { useEffect, useMemo, useState } from 'react'
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
const tableHeight = 520

type InventoryItem = {
  _id: Id<'items'>
  sku: string
  brand: string
  location: string
}

type ProductDraft = {
  id: string
  sku: string
  brand: string
  location: string
}

type ProductField = 'sku' | 'brand' | 'location'
type AddProductsStep = 'upload' | 'processing' | 'edit'

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function createEmptyDraft(): ProductDraft {
  return {
    id: crypto.randomUUID(),
    sku: '',
    brand: '',
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
    brand: existing.brand,
    location: existing.location,
  }
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

    return inventoryItems.filter((item) =>
      fuzzyMatch(`${item.sku} ${item.brand} ${item.location}`, query),
    )
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
        products: products.map(({ sku, brand, location }) => ({ sku, brand, location })),
      })
      setAddDialogOpen(false)
      setMessage('Inventory updated.')
    } catch (error) {
      setMessage(messageFromError(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleScanPurchaseOrder(file: File, brand: string) {
    if (!sessionToken) {
      throw new Error('Sign in first.')
    }

    const fileDataUrl = await fileToDataUrl(file)
    const result = await scanPurchaseOrder({
      sessionToken,
      fileName: file.name,
      fileDataUrl,
      brand,
    })

    return result.products.map((product) => ({
      id: crypto.randomUUID(),
      sku: product.sku,
      brand: product.brand,
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
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
        <Card>
          <CardContent className="text-sm">{message}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
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
                placeholder="Fuzzy search SKU, brand, location"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {items === undefined ? (
            <p className="text-muted-foreground rounded-md border p-6 text-center text-sm">
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
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  const visibleCount = Math.ceil(tableHeight / rowHeight) + 8
  const visibleItems = items.slice(startIndex, startIndex + visibleCount)

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="bg-muted/50 grid grid-cols-[1.2fr_1fr_1fr_3rem] border-b px-4 py-3 text-sm font-medium">
        <div>SKU</div>
        <div>Brand</div>
        <div>Location</div>
        <div className="sr-only">Remove</div>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground p-8 text-center text-sm">No products found.</p>
      ) : (
        <div
          className="overflow-auto"
          style={{ height: tableHeight }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: items.length * rowHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${startIndex * rowHeight}px)` }}>
              {visibleItems.map((item) => (
                <div
                  key={item._id}
                  className="grid grid-cols-[1.2fr_1fr_1fr_3rem] items-center border-b px-4 text-sm last:border-b-0"
                  style={{ height: rowHeight }}
                >
                  <div className="truncate font-medium">{item.sku}</div>
                  <div className="text-muted-foreground truncate">{item.brand || '-'}</div>
                  <div className="text-muted-foreground truncate">{item.location || '-'}</div>
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
  onScan: (file: File, brand: string) => Promise<ProductDraft[]>
  onSave: (products: ProductDraft[]) => Promise<void>
}) {
  const [step, setStep] = useState<AddProductsStep>('upload')
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [purchaseOrderBrand, setPurchaseOrderBrand] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<ProductDraft[]>([createEmptyDraft()])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkValue, setBulkValue] = useState('')
  const existingBySku = useMemo(
    () => new Map(existingItems.map((item) => [item.sku.toLowerCase(), item])),
    [existingItems],
  )
  const allSelected = drafts.length > 0 && selectedIds.size === drafts.length
  const saveableDrafts = drafts.filter((draft) => draft.sku.trim())

  function resetDraftState() {
    setStep('upload')
    setPdfFile(null)
    setPurchaseOrderBrand('')
    setScanning(false)
    setScanError(null)
    setDrafts([createEmptyDraft()])
    setSelectedIds(new Set())
    setBulkValue('')
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

    if (file) {
      setStep('processing')
    }
  }

  function startManualEntry() {
    setDrafts([createEmptyDraft()])
    setSelectedIds(new Set())
    setStep('edit')
  }

  async function handleScanPdf() {
    if (!pdfFile) {
      startManualEntry()
      return
    }

    setScanning(true)
    setScanError(null)

    try {
      const parsedDrafts = await onScan(pdfFile, purchaseOrderBrand)
      const hydratedDrafts = parsedDrafts.map((draft) => {
        const hydrated = hydrateSkuFromExisting(draft, existingBySku)

        return {
          ...hydrated,
          brand: purchaseOrderBrand.trim(),
        }
      })

      setDrafts(hydratedDrafts.length > 0 ? hydratedDrafts : [createEmptyDraft()])
      setSelectedIds(new Set())
      setStep('edit')
    } catch (error) {
      setScanError(messageFromError(error))
    } finally {
      setScanning(false)
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

  function applyBulkValue(field: ProductField) {
    if (!bulkValue || selectedIds.size === 0) {
      return
    }

    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) => {
        if (!selectedIds.has(draft.id)) {
          return draft
        }

        const updatedDraft = { ...draft, [field]: bulkValue }
        return field === 'sku' ? hydrateSkuFromExisting(updatedDraft, existingBySku) : updatedDraft
      }),
    )
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
                ? 'Enter the purchase order brand before scanning the PDF.'
                : 'Review and edit parsed products before saving.'}
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
                  {pdfFile?.name ?? 'Selected purchase order'} will be scanned for line item SKUs and part numbers.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="purchase-order-brand">Purchase order brand</Label>
                <Input
                  id="purchase-order-brand"
                  value={purchaseOrderBrand}
                  onChange={(event) => setPurchaseOrderBrand(event.target.value)}
                  placeholder="Brand for every line item"
                  disabled={scanning}
                />
              </div>
              {scanError ? (
                <p className="text-destructive text-sm">{scanError}</p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  The brand entered here will be applied to every parsed row on the edit page.
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
              <Button
                type="button"
                onClick={handleScanPdf}
                disabled={!purchaseOrderBrand.trim() || scanning}
              >
                {scanning ? 'Scanning PDF...' : 'Scan PDF'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div className="grid gap-3 rounded-md border p-3 lg:grid-cols-[1fr_auto_auto_auto] lg:items-end">
              <div className="space-y-2">
                <Label htmlFor="bulk-value">Bulk value for selected rows</Label>
                <Input
                  id="bulk-value"
                  value={bulkValue}
                  onChange={(event) => setBulkValue(event.target.value)}
                  placeholder="Value to apply"
                />
              </div>
              <Button type="button" variant="outline" onClick={() => applyBulkValue('sku')}>
                Apply SKU
              </Button>
              <Button type="button" variant="outline" onClick={() => applyBulkValue('brand')}>
                Apply Brand
              </Button>
              <Button type="button" variant="outline" onClick={() => applyBulkValue('location')}>
                Apply Location
              </Button>
            </div>

            <div className="overflow-auto rounded-md border">
              <div className="bg-muted/50 grid min-w-[760px] grid-cols-[3rem_1fr_1fr_1fr] items-center border-b px-3 py-3 text-sm font-medium">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all products"
                />
                <div>SKU</div>
                <div>Brand</div>
                <div>Location</div>
              </div>
              <div className="max-h-[320px] min-w-[760px] overflow-y-auto">
                {drafts.map((draft) => (
                  <div
                    key={draft.id}
                    className="grid grid-cols-[3rem_1fr_1fr_1fr] items-center gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <Checkbox
                      checked={selectedIds.has(draft.id)}
                      onCheckedChange={(checked) => toggleDraft(draft.id, checked === true)}
                      aria-label={`Select ${draft.sku || 'blank product row'}`}
                    />
                    <Input
                      value={draft.sku}
                      onChange={(event) => updateDraft(draft.id, 'sku', event.target.value)}
                      placeholder="SKU"
                    />
                    <Input
                      value={draft.brand}
                      onChange={(event) => updateDraft(draft.id, 'brand', event.target.value)}
                      placeholder="Brand"
                    />
                    <Input
                      value={draft.location}
                      onChange={(event) => updateDraft(draft.id, 'location', event.target.value)}
                      placeholder="Location"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDrafts((currentDrafts) => [...currentDrafts, createEmptyDraft()])}
              >
                <PlusIcon className="size-4" />
                Add row
              </Button>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(pdfFile ? 'processing' : 'upload')}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={saveableDrafts.length === 0 || saving}
                  onClick={() => onSave(saveableDrafts)}
                >
                  {saving ? 'Saving...' : `Save ${saveableDrafts.length} item${saveableDrafts.length === 1 ? '' : 's'}`}
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
