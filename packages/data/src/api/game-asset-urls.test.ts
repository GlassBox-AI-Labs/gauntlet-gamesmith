import { describe, expect, it } from 'vitest'
import { parse } from '@babel/parser'
import { createHash } from 'node:crypto'
import type { GameArtifact } from '@gauntlet/publishing'
import { gameAssetResponse } from './game-asset-urls'

const root = '/preview/22222222-2222-4222-8222-222222222222/valid/'
const files = ['index.html', 'assets/car.glb', 'assets/Car Model.glb', 'textures/body.png', 'audio/engine.ogg', 'fonts/game.woff2', 'styles/main.css', 'scripts/main.js', 'scripts/worker.js']
function fixture(filePath: string, source: string): GameArtifact {
  return { version: 1, sourceRevision: 'test', files: [...new Set([...files, filePath])].map(path => ({ path, data: Buffer.from(path === filePath ? source : 'asset').toString('base64'), sha256: 'unused' })) }
}
function response(file: string, source: string) {
  return gameAssetResponse(fixture(file, source), file, root).toString()
}

describe('release-scoped bundled asset URLs', () => {
  it('handles model loaders, fetch, workers, imports, URL constructors, and dynamic directory prefixes', () => {
    const source = [
      'import worker from "/scripts/worker.js";',
      'const models = ["/assets/car.glb", "/assets/Car%20Model.glb?quality=2#mesh"];',
      'fetch("/audio/engine.ogg"); new Worker("/scripts/worker.js");',
      'new URL("/assets/car.glb", import.meta.url);',
      'const dynamic = `/textures/${name}.png`;',
      'const prefix = "/assets/" + model;',
    ].join('\n')
    const output = response('scripts/main.js', source)
    expect(output).toContain(`"${root}assets/car.glb"`)
    expect(output).toContain(`"${root}assets/Car%20Model.glb?quality=2#mesh"`)
    expect(output).toContain(`"${root}scripts/worker.js"`)
    expect(output).toContain(`\`${root}textures/\${name}.png\``)
    expect(output).toContain(`"${root}assets/" + model`)
    expect(() => parse(output, { sourceType: 'module' })).not.toThrow()
  })
  it('leaves relative/external URLs, APIs, comments, regexes, and traversal unchanged', () => {
    const source = [
      'const a="./assets/car.glb", b="https://cdn.example/assets/car.glb", c="//cdn.example/assets/car.glb";',
      'const d="/api/login", e="/", f="/assets/../secret.txt";',
      '// fetch("/assets/car.glb")',
      'const re = /"\\/assets\\/car.glb"/;',
    ].join('\n')
    expect(response('scripts/main.js', source)).toBe(source)
  })
  it('scopes HTML resources, srcset, inline scripts/styles and a root base element', () => {
    const source = '<!doctype html><html><head><base href="/"><link href="/styles/main.css"><style>body{background:url(/textures/body.png)}</style></head><body><img src="/textures/body.png" srcset="/textures/body.png 1x, /textures/body.png 2x"><video poster="/textures/body.png"></video><script type="module" src="/scripts/main.js"></script><script>fetch("/assets/car.glb")</script></body></html>'
    const output = response('index.html', source)
    expect(output).toContain(`<base href="${root}">`)
    expect(output).toContain(`src="${root}scripts/main.js"`)
    expect(output).toContain(`srcset="${root}textures/body.png 1x, ${root}textures/body.png 2x"`)
    expect(output).toContain(`url(${root}textures/body.png)`)
    expect(output).toContain(`fetch("${root}assets/car.glb")`)
  })
  it('scopes CSS imports, fonts and image URLs without touching literal content or data URLs', () => {
    const source = '@import "/styles/main.css"; @font-face{src:url("/fonts/game.woff2")} body{background:url(/textures/body.png);content:"/assets/car.glb";mask:url(data:image/png;base64,abc)}'
    const output = response('styles/theme.css', source)
    expect(output).toContain(`@import "${root}styles/main.css"`)
    expect(output).toContain(`url("${root}fonts/game.woff2")`)
    expect(output).toContain(`url(${root}textures/body.png)`)
    expect(output).toContain('content:"/assets/car.glb"')
    expect(output).toContain('url(data:image/png;base64,abc)')
  })
  it('scopes URLs in JSON/GLTF manifests and SVG references', () => {
    const output = JSON.parse(response('assets/model.gltf', '{"images":[{"uri":"/textures/body.png"}],"relative":"body.bin"}'))
    expect(output.images[0].uri).toBe(root + 'textures/body.png')
    expect(output.relative).toBe('body.bin')
    expect(response('art.svg', '<svg><image href="/textures/body.png"/></svg>')).toContain(`href="${root}textures/body.png"`)
    expect(response('config.json', '{ "id": 9007199254740993123, "model": "/assets/car.glb" }'))
      .toBe(`{ "id": 9007199254740993123, "model": "${root}assets/car.glb" }`)
  })
  it('keeps binary data and cached artifacts unchanged and never mixes preview capabilities', () => {
    const artifact = fixture('scripts/main.js', 'fetch("/assets/car.glb")')
    const original = JSON.stringify(artifact)
    const a = gameAssetResponse(artifact, 'scripts/main.js', root).toString()
    const publishedRoot = '/play/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/'
    const b = gameAssetResponse(artifact, 'scripts/main.js', publishedRoot).toString()
    expect(a).toContain(root)
    expect(b).toContain(publishedRoot)
    expect(b).not.toContain('/preview/')
    expect(JSON.stringify(artifact)).toBe(original)
    expect(gameAssetResponse(artifact, 'assets/car.glb', root).toString()).toBe('asset')
  })
  it('updates bundled script integrity for the transformed bytes, preserving external integrity', () => {
    const artifact = fixture('scripts/main.js', 'fetch("/assets/car.glb")')
    const html = '<script src="./scripts/main.js" integrity="sha384-original"></script><script src="https://cdn.example/app.js" integrity="sha384-external"></script>'
    artifact.files.find(f => f.path === 'index.html')!.data = Buffer.from(html).toString('base64')
    const script = gameAssetResponse(artifact, 'scripts/main.js', root)
    const expected = createHash('sha384').update(script).digest('base64')
    const output = gameAssetResponse(artifact, 'index.html', root).toString()
    expect(output).toContain(`integrity="sha384-${expected}"`)
    expect(output).toContain('integrity="sha384-external"')
  })
})
