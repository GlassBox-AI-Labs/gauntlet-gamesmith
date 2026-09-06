import { SignInForm } from '@/components/features/auth/auth-form'
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { code } = await searchParams
  return (
    <section className="mx-auto max-w-md rounded-xl border bg-card p-8">
      <h1 className="mb-3 text-2xl font-semibold">Publisher sign in</h1>
      <p className="mb-7 text-sm text-muted-foreground">
        Use your provisioned Glassbox developer account.
      </p>
      <SignInForm code={code} />
    </section>
  )
}
