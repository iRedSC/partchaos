import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useAction, useMutation, useQuery } from 'convex/react'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const sessionStorageKey = 'partchaos.session'

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function App() {
  const [password, setPassword] = useState('')
  const [newItem, setNewItem] = useState('')
  const [sessionToken, setSessionToken] = useState(() =>
    window.localStorage.getItem(sessionStorageKey),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

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
  const addItem = useMutation(api.items.add)
  const removeItem = useMutation(api.items.remove)

  useEffect(() => {
    if (sessionToken && sessionStatus && !sessionStatus.authenticated) {
      window.localStorage.removeItem(sessionStorageKey)
    }
  }, [sessionStatus, sessionToken])

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

  async function handleAddItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!sessionToken) {
      setMessage('Sign in first.')
      return
    }

    setBusy('add-item')
    setMessage(null)

    try {
      await addItem({ sessionToken, text: newItem })
      setNewItem('')
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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <section className="space-y-2">
        <p className="text-muted-foreground text-sm">partchaos</p>
        <h1 className="text-4xl font-semibold tracking-tight">Tiny Convex passkey app</h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          One universal password can create global passkeys. After that, passkeys unlock a
          shared list stored in Convex.
        </p>
      </section>

      {message ? (
        <Card>
          <CardContent className="text-sm">{message}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Passkey</CardTitle>
            <CardDescription>
              Uses the Convex {passkeyStatus?.hasPasskey ? 'universal password' : 'universal password for the first passkey'}.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleCreatePasskey}>
            <CardContent className="space-y-3">
              <Label htmlFor="password">Universal password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={!password || busy === 'create-passkey'}>
                {busy === 'create-passkey' ? 'Creating...' : 'Create passkey'}
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>
              {passkeyStatus?.passkeyCount ?? 0} global passkey
              {(passkeyStatus?.passkeyCount ?? 0) === 1 ? '' : 's'} registered.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              className="w-full"
              onClick={handleSignIn}
              disabled={!passkeyStatus?.hasPasskey || busy === 'sign-in'}
            >
              {busy === 'sign-in' ? 'Opening passkey...' : 'Sign in with passkey'}
            </Button>
            {isAuthenticated ? (
              <Button type="button" variant="outline" className="w-full" onClick={handleSignOut}>
                Sign out
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Basic Data</CardTitle>
          <CardDescription>A tiny shared list backed by Convex.</CardDescription>
        </CardHeader>
        <form onSubmit={handleAddItem}>
          <CardContent className="flex gap-2">
            <Input
              value={newItem}
              onChange={(event) => setNewItem(event.target.value)}
              placeholder={isAuthenticated ? 'Add something small' : 'Sign in to add data'}
              disabled={!isAuthenticated}
            />
            <Button type="submit" disabled={!isAuthenticated || busy === 'add-item'}>
              Add
            </Button>
          </CardContent>
        </form>
        <CardContent className="space-y-2 pt-4">
          {!isAuthenticated ? (
            <p className="text-muted-foreground text-sm">Sign in to read and write Convex data.</p>
          ) : items === undefined ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-sm">No data yet.</p>
          ) : (
            items.map((item) => (
              <div
                key={item._id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="text-sm">{item.text}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveItem(item._id)}
                  disabled={busy === item._id}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </main>
  )
}

export default App
