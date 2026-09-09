import { Bricolage_Grotesque, Geist, Geist_Mono } from 'next/font/google'
// next/font only allows extra axes on the variable weight, which covers 500, 700, and 800.
export const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['opsz'],
  variable: '--font-display',
})
export const body = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
})
export const mono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
})
export const fontClass = `${display.variable} ${body.variable} ${mono.variable}`
