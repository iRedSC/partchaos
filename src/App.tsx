import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useAction, useMutation, useQuery } from 'convex/react'
import { CheckIcon, DownloadIcon, PlusIcon, SearchIcon, Trash2Icon, UploadIcon } from 'lucide-react'

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
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

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

type QuickAddRequest = {
  id: string
  sku: string
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

function normalizeSkuForSimilarity(sku: string) {
  return sku.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function removeSkuPrefix(sku: string) {
  const dashIndex = sku.indexOf('-')
  return dashIndex === -1 ? sku : sku.slice(dashIndex + 1)
}

function nonAlphanumericSegments(sku: string) {
  const segments: string[] = []
  let segment = ''

  for (const char of sku) {
    if (/^[a-z0-9]$/i.test(char)) {
      segments.push(segment)
      segment = ''
    } else {
      segment += char
    }
  }

  segments.push(segment)
  return segments
}

function editDistance(value: string, candidate: string) {
  const distances = Array.from({ length: value.length + 1 }, (_, valueIndex) =>
    Array.from({ length: candidate.length + 1 }, (_, candidateIndex) =>
      valueIndex === 0 ? candidateIndex : candidateIndex === 0 ? valueIndex : 0,
    ),
  )

  for (let valueIndex = 1; valueIndex <= value.length; valueIndex += 1) {
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      const substitutionCost = value[valueIndex - 1] === candidate[candidateIndex - 1] ? 0 : 1

      distances[valueIndex][candidateIndex] = Math.min(
        distances[valueIndex - 1][candidateIndex] + 1,
        distances[valueIndex][candidateIndex - 1] + 1,
        distances[valueIndex - 1][candidateIndex - 1] + substitutionCost,
      )
    }
  }

  return distances[value.length][candidate.length]
}

function nonAlphanumericDifference(value: string, candidate: string) {
  const valueSegments = nonAlphanumericSegments(value)
  const candidateSegments = nonAlphanumericSegments(candidate)

  return valueSegments.reduce(
    (difference, segment, index) => difference + editDistance(segment, candidateSegments[index] ?? ''),
    0,
  )
}

function getSeparatorSkuSuggestion(trimmedSku: string, normalizedSku: string, existingItems: InventoryItem[]) {
  let suggestion: { sku: string; difference: number } | null = null

  for (const item of existingItems) {
    const existingSku = item.sku.trim()
    const candidateSkus = [
      { sku: existingSku, allowsExactSeparatorMatch: false },
      { sku: removeSkuPrefix(existingSku), allowsExactSeparatorMatch: true },
    ]
    const match = candidateSkus.find((candidate) => {
      if (
        existingSku.toLowerCase() === trimmedSku.toLowerCase() ||
        normalizeSkuForSimilarity(candidate.sku) !== normalizedSku
      ) {
        return false
      }

      const difference = nonAlphanumericDifference(trimmedSku, candidate.sku)
      return candidate.allowsExactSeparatorMatch ? difference <= 3 : difference >= 1 && difference <= 3
    })

    if (!match) {
      continue
    }

    const difference = nonAlphanumericDifference(trimmedSku, match.sku)

    if (!suggestion || difference < suggestion.difference) {
      suggestion = { sku: item.sku, difference }
    }
  }

  return suggestion?.sku ?? null
}

function getSingleCharacterSkuSuggestion(
  trimmedSku: string,
  normalizedSku: string,
  existingItems: InventoryItem[],
) {
  let suggestion: string | null = null

  for (const item of existingItems) {
    const existingSku = item.sku.trim()

    if (existingSku.toLowerCase() === trimmedSku.toLowerCase()) {
      continue
    }

    const candidateSkus = [existingSku, removeSkuPrefix(existingSku)]
    const isOneCharacterOff = candidateSkus.some(
      (candidate) => editDistance(normalizedSku, normalizeSkuForSimilarity(candidate)) === 1,
    )

    if (!isOneCharacterOff) {
      continue
    }

    if (suggestion) {
      return null
    }

    suggestion = item.sku
  }

  return suggestion
}

function getSimilarSkuSuggestion(sku: string, existingItems: InventoryItem[]) {
  const trimmedSku = sku.trim()
  const normalizedSku = normalizeSkuForSimilarity(trimmedSku)

  if (!normalizedSku) {
    return null
  }

  if (existingItems.some((item) => item.sku.trim().toLowerCase() === trimmedSku.toLowerCase())) {
    return null
  }

  return (
    getSeparatorSkuSuggestion(trimmedSku, normalizedSku, existingItems) ??
    getSingleCharacterSkuSuggestion(trimmedSku, normalizedSku, existingItems)
  )
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

function getLocationOptions(existingItems: InventoryItem[]) {
  return Array.from(
    new Set(
      existingItems
        .map((item) => item.location.trim())
        .filter(Boolean),
    ),
  ).sort((firstLocation, secondLocation) =>
    firstLocation.localeCompare(secondLocation, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

function SimilarSkuButton({ sku, onApply }: { sku: string; onApply: () => void }) {
  const tooltipId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null)

  function showTooltip() {
    const rect = buttonRef.current?.getBoundingClientRect()

    if (!rect) {
      return
    }

    setTooltipPosition({
      top: rect.bottom + 6,
      left: rect.right,
    })
  }

  function hideTooltip() {
    setTooltipPosition(null)
  }

  useEffect(() => {
    if (!tooltipPosition) {
      return
    }

    window.addEventListener('scroll', showTooltip, true)
    window.addEventListener('resize', showTooltip)
    return () => {
      window.removeEventListener('scroll', showTooltip, true)
      window.removeEventListener('resize', showTooltip)
    }
  }, [tooltipPosition])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="absolute top-1/2 right-7 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm border border-yellow-300 bg-yellow-100 text-yellow-700 shadow-xs transition-colors outline-none hover:bg-yellow-200 hover:text-yellow-800 focus-visible:ring-3 focus-visible:ring-yellow-300/60"
        aria-describedby={tooltipPosition ? tooltipId : undefined}
        aria-label={`Use existing SKU ${sku}`}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onClick={(event) => {
          event.stopPropagation()
          onApply()
        }}
      >
        <DownloadIcon className="size-3.5" />
      </button>
      {tooltipPosition
        ? createPortal(
            <div
              id={tooltipId}
              role="tooltip"
              className="bg-popover text-popover-foreground border-border pointer-events-none fixed z-50 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium shadow-md"
              style={{
                top: tooltipPosition.top,
                left: tooltipPosition.left,
                transform: 'translateX(-100%)',
              }}
            >
              Similar SKU already exists: {sku}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function LocationCombobox({
  value,
  options,
  inputRef,
  onChange,
}: {
  value: string
  options: string[]
  inputRef?: React.Ref<HTMLInputElement>
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const trimmedValue = value.trim()
  const matchingOptions = options.filter((option) => fuzzyMatch(option, value))
  const hasMatches = matchingOptions.length > 0

  function selectLocation(location: string) {
    onChange(location)
    setOpen(false)
  }

  return (
    <Command shouldFilter={false}>
      <Popover open={open && hasMatches}>
        <PopoverAnchor asChild>
          <CommandInput
            ref={inputRef}
            className="h-9 px-3 py-1"
            wrapperClassName="h-9 rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px] [&>svg]:hidden"
            role="combobox"
            aria-expanded={open && hasMatches}
            value={value}
            onFocus={() => setOpen(hasMatches)}
            onBlur={(event) => {
              const nextFocusedElement = event.relatedTarget

              if (nextFocusedElement instanceof HTMLElement && nextFocusedElement.closest('[data-slot="popover-content"]')) {
                return
              }

              setOpen(false)
            }}
            onValueChange={(nextValue) => {
              onChange(nextValue)
              setOpen(options.some((option) => fuzzyMatch(option, nextValue)))
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder="Location"
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0"
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <CommandList>
            <CommandGroup>
              {matchingOptions.map((location) => (
                <CommandItem key={location} value={location} onSelect={() => selectLocation(location)}>
                  <CheckIcon
                    className={cn(
                      'size-4',
                      location.toLowerCase() === trimmedValue.toLowerCase() ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {location}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </PopoverContent>
      </Popover>
    </Command>
  )
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
  const [quickAddRequest, setQuickAddRequest] = useState<QuickAddRequest | null>(null)

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
  const canQuickAddSearch = items !== undefined && Boolean(search.trim()) && filteredItems.length === 0

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

  function handleQuickAddSearch() {
    const sku = search.trim()

    if (!sku) {
      return
    }

    setQuickAddRequest({ id: crypto.randomUUID(), sku })
    setAddDialogOpen(true)
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
            quickAddRequest={quickAddRequest}
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

      <Card className="min-h-0 w-full min-w-0 flex-1 basis-0 overflow-hidden pb-0">
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
            <div className="flex w-full gap-2 sm:max-w-sm">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Fuzzy search SKU or location"
                />
              </div>
              {canQuickAddSearch ? (
                <Button
                  type="button"
                  size="icon"
                  aria-label={`Add ${search.trim()}`}
                  onClick={handleQuickAddSearch}
                >
                  <PlusIcon className="size-4" />
                </Button>
              ) : null}
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
  const hasItems = items.length > 0

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current

    if (!scrollContainer) {
      setScrollTop(0)
      return
    }

    scrollContainer.scrollTop = 0
    setScrollTop(0)
  }, [items])

  useLayoutEffect(() => {
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
  }, [hasItems])

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
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
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
  quickAddRequest,
  saving,
  onOpenChange,
  onScan,
  onSave,
}: {
  open: boolean
  existingItems: InventoryItem[]
  quickAddRequest: QuickAddRequest | null
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
  const firstLocationInputRef = useRef<HTMLInputElement>(null)
  const shouldFocusLocationOnEdit = useRef(false)
  const handledQuickAddRequestId = useRef<string | null>(null)
  const existingBySku = useMemo(
    () => new Map(existingItems.map((item) => [item.sku.toLowerCase(), item])),
    [existingItems],
  )
  const locationOptions = useMemo(() => getLocationOptions(existingItems), [existingItems])
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

  useEffect(() => {
    if (!open || !quickAddRequest || handledQuickAddRequestId.current === quickAddRequest.id) {
      return
    }

    const draft = hydrateSkuFromExisting(
      { ...createEmptyDraft(), sku: quickAddRequest.sku },
      existingBySku,
    )

    handledQuickAddRequestId.current = quickAddRequest.id
    setPdfFile(null)
    setBrandPrefix('')
    setScanning(false)
    setScanError(null)
    setDrafts([draft])
    setSelectedIds(new Set([draft.id]))
    setFillSelection(null)
    setStep('edit')
    shouldFocusLocationOnEdit.current = true
    activeScanId.current += 1
  }, [existingBySku, open, quickAddRequest])

  useEffect(() => {
    if (!open || step !== 'edit' || !shouldFocusLocationOnEdit.current) {
      return
    }

    shouldFocusLocationOnEdit.current = false
    const focusLocation = () => {
      firstLocationInputRef.current?.focus()
    }
    const frameId = window.requestAnimationFrame(focusLocation)
    const timeoutId = window.setTimeout(focusLocation, 0)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [open, step])

  function resetDraftState() {
    setStep('upload')
    setPdfFile(null)
    setBrandPrefix('')
    setScanning(false)
    setScanError(null)
    setDrafts([createEmptyDraft()])
    setSelectedIds(new Set())
    setFillSelection(null)
    shouldFocusLocationOnEdit.current = false
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

  function applySkuSuggestion(id: string, sku: string) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.id === id ? hydrateSkuFromExisting({ ...draft, sku }, existingBySku) : draft,
      ),
    )
  }

  function removeEditableRow(id: string) {
    setDrafts((currentDrafts) => currentDrafts.filter((draft) => draft.id !== id))
    setSelectedIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setFillSelection((current) =>
      current?.sourceId === id || current?.targetId === id ? null : current,
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
              <div className="bg-muted/50 grid min-w-[640px] grid-cols-[1.5fr_1fr_3rem] items-center gap-3 border-b px-3 py-3 text-sm font-medium">
                <div>SKU</div>
                <div>Location</div>
                <div className="sr-only">Remove</div>
              </div>
              <div className="max-h-[320px] min-w-[640px] overflow-y-auto">
                {drafts.map((draft, rowIndex) => {
                  return (
                    <div
                      key={draft.id}
                      className="grid grid-cols-[1.5fr_1fr_3rem] items-center gap-3 border-b px-3 py-2 last:border-b-0"
                    >
                      {productFields.map((field) => {
                        const isInFillRange =
                          fillRange?.field === field &&
                          rowIndex >= fillRange.start &&
                          rowIndex <= fillRange.end
                        const similarSku =
                          field === 'sku' ? getSimilarSkuSuggestion(draft.sku, existingItems) : null

                        return (
                          <div
                            key={field}
                            className={`relative rounded-md ${isInFillRange ? 'ring-primary ring-2' : ''}`}
                            onPointerEnter={() => updateFillSelectionTarget(draft.id)}
                          >
                            {field === 'location' ? (
                              <LocationCombobox
                                inputRef={rowIndex === 0 ? firstLocationInputRef : undefined}
                                value={draft.location}
                                options={locationOptions}
                                onChange={(value) => updateDraft(draft.id, 'location', value)}
                              />
                            ) : (
                              <Input
                                className={similarSku ? 'pr-16' : 'pr-6'}
                                value={draft.sku}
                                onChange={(event) => updateDraft(draft.id, 'sku', event.target.value)}
                                placeholder="SKU"
                              />
                            )}
                            {similarSku ? (
                              <SimilarSkuButton
                                sku={similarSku}
                                onApply={() => {
                                  applySkuSuggestion(draft.id, similarSku)
                                }}
                              />
                            ) : null}
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${draft.sku || 'blank product row'}`}
                        onClick={() => removeEditableRow(draft.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
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
                  {saving ? 'Saving...' : `Save ${saveableDrafts.length} products`}
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
