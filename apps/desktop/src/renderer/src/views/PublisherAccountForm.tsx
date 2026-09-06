import { useState } from 'react'
import { PUBLISHER_EMAIL_DOMAIN } from '@gauntlet/publishing'
import { Button } from '@gauntlet/ui/button'
import { Input } from '@gauntlet/ui/input'
import type { PublisherStatus } from '../../../shared/publishing'

export function PublisherAccountForm({
  onConnected,
  onBusyChange,
}: {
  onConnected: (status: PublisherStatus) => Promise<void>
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'signin' | 'signup' | 'verify'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  function changeMode(next: typeof mode) {
    setPassword('')
    setCode('')
    setError('')
    setNotice('')
    setMode(next)
  }
  async function work(operation: () => Promise<void>) {
    setBusy(true)
    onBusyChange(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Account request failed.',
      )
    } finally {
      setPassword('')
      setCode('')
      setBusy(false)
      onBusyChange(false)
    }
  }
  async function submit() {
    if (mode === 'signup') {
      const result = await window.publishing.signUp({
        email,
        password,
        displayName,
      })
      if (!result.ok) throw new Error(result.error)
      setMode('verify')
      setNotice(
        'Check your email for a verification code. If you already have an account, sign in instead.',
      )
      return
    }
    const result =
      mode === 'verify'
        ? await window.publishing.verifyEmail({ email, code })
        : await window.publishing.signIn({ email, password })
    if (!result.ok) throw new Error(result.error)
    await onConnected(result.value)
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void work(submit)
      }}
    >
      <p className="text-sm text-muted-foreground">
        {mode === 'verify'
          ? 'Enter the code sent to your Challenger email to finish creating your publisher account.'
          : `Anyone with a verified @${PUBLISHER_EMAIL_DOMAIN} email can create a publisher account. Creating and playing games locally needs no account.`}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border bg-secondary p-3 text-sm">
          {notice}
        </p>
      )}
      <label className="grid gap-2 text-sm">
        Email
        <Input
          data-testid="publishing-email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          disabled={busy}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {mode === 'signup' && (
        <label className="grid gap-2 text-sm">
          Public publisher name
          <Input
            data-testid="publishing-display-name"
            autoComplete="nickname"
            required
            maxLength={80}
            disabled={busy}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
      )}
      {mode === 'verify' ? (
        <label className="grid gap-2 text-sm">
          Verification code
          <Input
            data-testid="publishing-verification-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            pattern="[0-9]{6,10}"
            maxLength={10}
            disabled={busy}
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
          />
        </label>
      ) : (
        <label className="grid gap-2 text-sm">
          Password{mode === 'signup' ? ' (at least 10 characters)' : ''}
          <Input
            data-testid="publishing-password"
            type="password"
            autoComplete={
              mode === 'signup' ? 'new-password' : 'current-password'
            }
            required
            minLength={mode === 'signup' ? 10 : 1}
            maxLength={200}
            disabled={busy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          data-testid={
            mode === 'signin'
              ? 'publishing-sign-in'
              : mode === 'signup'
                ? 'publishing-sign-up'
                : 'publishing-verify-email'
          }
          type="submit"
          disabled={busy}
        >
          {busy
            ? 'Please wait…'
            : mode === 'signin'
              ? 'Sign in to publish'
              : mode === 'signup'
                ? 'Create account'
                : 'Verify email'}
        </Button>
        {busy && (
          <Button
            data-testid="publishing-cancel-sign-in"
            type="button"
            variant="outline"
            onClick={() => {
              void window.publishing
                .cancelSignIn()
                .then((result) => {
                  if (!result.ok) setError(result.error)
                })
                .catch(() => setError('Unable to cancel account request.'))
            }}
          >
            Cancel
          </Button>
        )}
        {mode === 'verify' && (
          <Button
            data-testid="publishing-resend-code"
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const result = await window.publishing.resendVerification({
                  email,
                })
                if (!result.ok) throw new Error(result.error)
                setNotice(
                  'A new code has been requested. Check your email, including spam.',
                )
              })
            }
          >
            Resend code
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="publishing-account-mode"
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => changeMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin'
            ? 'Create a Challenger account'
            : 'Back to sign in'}
        </Button>
        {mode !== 'verify' && (
          <Button
            data-testid="publishing-have-code"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => changeMode('verify')}
          >
            I have a verification code
          </Button>
        )}
      </div>
    </form>
  )
}
