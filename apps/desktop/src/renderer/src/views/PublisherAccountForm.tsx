import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, Mail } from 'lucide-react'
import { Button } from '@gauntlet/ui/button'
import { Input } from '@gauntlet/ui/input'
import { PUBLISHER_OTP_LENGTH, isPublisherOtp } from '@gauntlet/publishing'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@gauntlet/ui/input-otp'
import type { PublisherStatus } from '../../../shared/publishing'

type Step = 'email' | 'signin' | 'signup' | 'verify'
const OTP_SLOTS = Array.from(
  { length: PUBLISHER_OTP_LENGTH },
  (_, index) => index,
)

export function PublisherAccountForm({
  onConnected,
  onBusyChange,
}: {
  onConnected: (status: PublisherStatus) => Promise<void>
  onBusyChange: (busy: boolean) => void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>('email')
  const [purpose, setPurpose] = useState<'signin' | 'signup'>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const resendCooldown = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const id = useId()

  useEffect(() => {
    setNow(Date.now())
    if (resendAt <= Date.now()) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= resendAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendAt])

  function changeStep(next: Step) {
    setPassword('')
    setCode('')
    setError('')
    setNotice('')
    setStep(next)
  }
  async function work(operation: () => Promise<void>) {
    // Completing the OTP and pressing Enter can happen in the same frame.
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    onBusyChange(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Account request failed.',
      )
    } finally {
      setPassword('')
      inFlight.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }
  function startVerification(nextPurpose: typeof purpose) {
    setPurpose(nextPurpose)
    setCode('')
    setResendAt(Date.now() + 60_000)
    setStep('verify')
  }
  async function verify(value: string) {
    if (!isPublisherOtp(value)) return
    await work(async () => {
      const result = await window.publishing.verifyEmail({ email, code: value })
      if (!result.ok) throw new Error(result.error)
      setCode('')
      await onConnected(result.value)
    })
  }
  async function submit() {
    if (step === 'email') {
      setEmail(email.trim())
      changeStep('signin')
      return
    }
    if (step === 'verify') {
      await verify(code)
      return
    }
    await work(async () => {
      if (step === 'signup') {
        const result = await window.publishing.signUp({
          email: email.trim(),
          password,
          displayName,
        })
        if (!result.ok) throw new Error(result.error)
        setEmail(email.trim())
        startVerification('signup')
        return
      }
      const result = await window.publishing.signIn({ email, password })
      if (!result.ok) throw new Error(result.error)
      await onConnected(result.value)
    })
  }
  async function sendCode() {
    await work(async () => {
      const result = await window.publishing.sendSignInCode({ email })
      if (!result.ok) throw new Error(result.error)
      startVerification('signin')
    })
  }
  async function resend() {
    await work(async () => {
      const result =
        purpose === 'signup'
          ? await window.publishing.resendVerification({ email })
          : await window.publishing.sendSignInCode({ email })
      if (!result.ok) throw new Error(result.error)
      setCode('')
      setResendAt(Date.now() + 60_000)
      setNotice('New code sent. Check your inbox, including spam.')
    })
  }

  return (
    <form
      className="w-full max-w-sm space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {(step === 'signin' || step === 'verify') && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back"
              disabled={busy}
              onClick={() => changeStep(step === 'verify' ? purpose : 'email')}
            >
              <ArrowLeft />
            </Button>
          )}
          <h2 className="text-lg font-semibold">
            {step === 'email'
              ? 'Sign in to continue'
              : step === 'signin'
                ? 'Welcome back'
                : step === 'signup'
                  ? 'Create your account'
                  : 'Enter your code'}
          </h2>
        </div>
        <p
          id={`${id}-description`}
          className="break-words text-sm text-muted-foreground"
        >
          {step === 'email' ? (
            'Enter your email to get started.'
          ) : step === 'signin' ? (
            email
          ) : step === 'signup' ? (
            'Create an account to share your games.'
          ) : (
            <>
              We sent an {PUBLISHER_OTP_LENGTH}-digit code to{' '}
              <strong className="text-foreground">{email}</strong>
            </>
          )}
        </p>
      </div>
      {(step === 'email' || step === 'signup') && (
        <label className="grid gap-2 text-sm">
          Email
          <Input
            key={step}
            data-testid="publishing-email"
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            required
            maxLength={254}
            disabled={busy}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
      )}
      {step === 'signup' && (
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
      {(step === 'signin' || step === 'signup') && (
        <label className="grid gap-2 text-sm">
          Password{step === 'signup' ? ' (at least 10 characters)' : ''}
          <Input
            key={step}
            data-testid="publishing-password"
            type="password"
            autoComplete={
              step === 'signup' ? 'new-password' : 'current-password'
            }
            autoFocus={step === 'signin'}
            required
            minLength={step === 'signup' ? 10 : 1}
            maxLength={200}
            disabled={busy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      {step === 'verify' && (
        <div className="grid justify-items-center gap-2 py-2">
          <label htmlFor={`${id}-code`} className="sr-only">
            Verification code
          </label>
          <InputOTP
            id={`${id}-code`}
            data-testid="publishing-verification-code"
            aria-describedby={`${id}-description${error ? ` ${id}-error` : ''}`}
            aria-invalid={!!error}
            maxLength={PUBLISHER_OTP_LENGTH}
            pattern="^[0-9]*$"
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            disabled={busy}
            value={code}
            onChange={setCode}
            onComplete={(value) => void verify(value)}
          >
            <InputOTPGroup>
              {OTP_SLOTS.slice(0, PUBLISHER_OTP_LENGTH / 2).map((index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={!!error}
                />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {OTP_SLOTS.slice(PUBLISHER_OTP_LENGTH / 2).map((index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={!!error}
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <Button
        className="w-full"
        data-testid={
          step === 'email'
            ? 'publishing-continue'
            : step === 'signin'
              ? 'publishing-sign-in'
              : step === 'signup'
                ? 'publishing-sign-up'
                : 'publishing-verify-email'
        }
        type="submit"
        disabled={busy || (step === 'verify' && !isPublisherOtp(code))}
      >
        {busy
          ? step === 'verify'
            ? 'Verifying…'
            : 'Please wait…'
          : step === 'email'
            ? 'Continue'
            : step === 'signin'
              ? 'Sign in'
              : step === 'signup'
                ? 'Create account'
                : 'Verify'}
      </Button>
      {step === 'signin' && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex-1 border-t" />
            or
            <div className="flex-1 border-t" />
          </div>
          <Button
            className="w-full"
            data-testid="publishing-send-code"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void sendCode()}
          >
            <Mail />
            Email me a code
          </Button>
        </>
      )}
      {step === 'verify' && (
        <Button
          className="w-full"
          data-testid="publishing-resend-code"
          type="button"
          variant="ghost"
          disabled={busy || resendCooldown > 0}
          onClick={() => void resend()}
        >
          {resendCooldown > 0
            ? `Resend code (${resendCooldown}s)`
            : 'Resend code'}
        </Button>
      )}
      {(step === 'email' || step === 'signup') && (
        <p className="text-center text-sm text-muted-foreground">
          {step === 'email'
            ? 'Don’t have an account? '
            : 'Already have an account? '}
          <button
            className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
            data-testid="publishing-account-mode"
            type="button"
            disabled={busy}
            onClick={() => changeStep(step === 'email' ? 'signup' : 'email')}
          >
            {step === 'email' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      )}
      {busy && (
        <Button
          className="w-full"
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
    </form>
  )
}
