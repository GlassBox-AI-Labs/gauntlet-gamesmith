import { route, readBody, requestPublisher } from '@/lib/http'
export const GET = route('health', async () => ({ ok: true }))
