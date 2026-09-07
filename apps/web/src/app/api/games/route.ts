import { route, readBody, requestPublisher } from '@/lib/http'
import * as catalogApi from '@gauntlet/data/api/catalog'
import { createAnonClient } from '@/lib/supabase-anon'
import { captureServerError } from '@/lib/capture'
export const GET = route('games', async () =>
  catalogApi.publicGames(createAnonClient(), captureServerError),
)
