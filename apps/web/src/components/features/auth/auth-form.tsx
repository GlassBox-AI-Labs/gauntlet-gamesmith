'use client'
import { useActionState, useState } from 'react'
import { Button } from '@gauntlet/ui/button'
import { Input } from '@gauntlet/ui/input'
import { signIn, approveConnection } from '@/app/auth-actions'
export function SignInForm({ code }: { code?: string }) {
  const [state, action, pending] = useActionState(signIn, null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="code" value={code ?? ''} />
      {state && !state.ok && (
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
      )}
      <label className="grid gap-2 text-sm">
        Email
        <Input
          data-testid="publisher-email"
          name="email"
          disabled={pending}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          autoComplete="username"
          required
        />
      </label>
      <label className="grid gap-2 text-sm">
        Password
        <Input
          data-testid="publisher-password"
          name="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <Button data-testid="publisher-sign-in" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
export function ConnectForm({ code }: { code: string }) {
  const [state, action, pending] = useActionState(approveConnection, null)
  return (
    <form action={action} className="space-y-5">
      <input name="code" type="hidden" value={code} />
      <p className="text-muted-foreground">
        Approve only if you just started publishing sign-in in your desktop app.
      </p>
      <p>
        Connection code: <code>{code}</code>
      </p>
      {state && !state.ok && (
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
      )}
      <Button data-testid="desktop-approve" disabled={pending}>
        {pending ? 'Connecting…' : 'Connect desktop'}
      </Button>
    </form>
  )
}
