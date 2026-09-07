import type { ReactNode } from 'react'
export function Brand({ logo, suffix }: { logo: ReactNode; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-3 text-lg font-semibold tracking-tight">
      {logo}
      <span>
        glassbox
        {suffix && (
          <span className="ml-2 font-normal text-muted-foreground">
            {suffix}
          </span>
        )}
      </span>
    </span>
  )
}
