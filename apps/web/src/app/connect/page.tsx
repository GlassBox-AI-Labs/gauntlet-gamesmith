import { redirect } from 'next/navigation'
import { getPublisher } from '@/lib/auth-user'
import { ConnectForm } from '@/components/features/auth/auth-form'
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { code } = await searchParams
  if (!code || !/^[a-f0-9]{16}$/.test(code))
    return <p>Start sign-in from the desktop app.</p>
  const publisher = await getPublisher()
  if (!publisher) redirect(`/login?code=${code}`)
  return (
    <section className="mx-auto max-w-lg space-y-6 rounded-xl border bg-card p-8">
      <h1 className="text-2xl font-semibold">Connect your desktop</h1>
      <p className="text-muted-foreground">
        Signed in as {publisher.display_name}
      </p>
      <ConnectForm code={code} />
    </section>
  )
}
