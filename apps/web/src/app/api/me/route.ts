import { route, readBody, requestPublisher } from '@/lib/http'
import * as catalogApi from '@gauntlet/data/api/catalog'
import { createAdminClient } from '@/lib/supabase-admin'
import { captureServerError } from '@/lib/capture'
export const GET = route('me', async (request) =>
  catalogApi.studio(
    createAdminClient(),
    captureServerError,
    (await requestPublisher(request)).id,
  ),
)
