import 'server-only'
import { cache } from 'react'
import * as catalogApi from '@gauntlet/data/api/catalog'
import { createAnonClient } from './supabase-anon'
import { captureServerError } from './capture'

// Share one public snapshot between the page and its metadata within a request.
export const publicGames = cache(() =>
  catalogApi.publicGames(createAnonClient(), captureServerError),
)
