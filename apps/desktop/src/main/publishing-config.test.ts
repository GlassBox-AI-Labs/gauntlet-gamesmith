import { describe, expect, it } from 'vitest'
import { publishingConfig } from './publishing-config'

describe('publishing endpoints', () => {
  it('uses hosted signup and game previews without environment setup', () => {
    expect(publishingConfig({})).toEqual({
      catalogUrl: 'https://gauntletgamesmith.com',
      gameOrigin: 'https://glassbox-games.vercel.app',
    })
  })

  it('pairs an explicitly selected production catalog with the hosted game origin', () => {
    expect(publishingConfig({ GAUNTLET_CATALOG_URL: 'https://gauntletgamesmith.com/' }).gameOrigin)
      .toBe('https://glassbox-games.vercel.app')
  })

  it('keeps local catalog development explicit', () => {
    expect(publishingConfig({ GAUNTLET_CATALOG_URL: 'http://127.0.0.1:4310' })).toEqual({
      catalogUrl: 'http://127.0.0.1:4310',
      gameOrigin: 'http://127.0.0.1:4311',
    })
    expect(publishingConfig({
      GAUNTLET_CATALOG_URL: 'http://localhost:4310',
      GAUNTLET_GAME_PORT: '5321',
    }).gameOrigin).toBe('http://localhost:5321')
  })

  it('respects a separate staging game origin', () => {
    expect(publishingConfig({
      GAUNTLET_CATALOG_URL: 'https://catalog.example.test',
      GAUNTLET_GAME_ORIGIN: 'https://games.example.test/',
      GAUNTLET_GAME_PORT: '5321',
    })).toEqual({
      catalogUrl: 'https://catalog.example.test',
      gameOrigin: 'https://games.example.test',
    })
  })
})
