import { parse as parseJavaScript } from '@babel/parser'
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import type { GameArtifact } from '@gauntlet/publishing'
import { createHash } from 'node:crypto'

type Edit = { start: number; end: number; text: string }
type Rewrite = (url: string) => string

function applyEdits(source: string, edits: Edit[]): string {
  let result = source
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

/** Parse executable text: comments and regex literals are never URL replacements. */
function javascript(source: string, rewrite: Rewrite): string {
  const tree = parseJavaScript(source, { sourceType: 'unambiguous', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  const edits: Edit[] = []
  const pending: unknown[] = [tree.program]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const node = value as Record<string, any>
    if (node.type === 'StringLiteral' || node.type === 'TemplateElement') {
      const before = node.type === 'StringLiteral' ? node.value : node.value.cooked
      if (typeof before === 'string') {
        const after = rewrite(before)
        if (after !== before) edits.push({
          start: node.start, end: node.end,
          text: node.type === 'StringLiteral' ? JSON.stringify(after).replace(/</g, '\\u003c') :
            JSON.stringify(after).slice(1, -1).replace(/</g, '\\u003c').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'),
        })
      }
      continue
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
      if (Array.isArray(child)) pending.push(...child)
      else if (child && typeof child === 'object') pending.push(child)
    }
  }
  return applyEdits(source, edits)
}

function cssValue(source: string, rewrite: Rewrite, imports = false): string {
  const value = valueParser(source)
  value.walk(node => {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') {
      for (const child of node.nodes)
        if (child.type === 'word' || child.type === 'string') child.value = rewrite(child.value)
      return false
    }
    if (node.type === 'function' && ['image-set', '-webkit-image-set'].includes(node.value.toLowerCase())) {
      for (const child of node.nodes)
        if (child.type === 'string') child.value = rewrite(child.value)
    }
    if (imports && node.type === 'string') node.value = rewrite(node.value)
  })
  return value.toString()
}

function css(source: string, rewrite: Rewrite): string {
  const sheet = postcss.parse(source)
  sheet.walkDecls(declaration => { declaration.value = cssValue(declaration.value, rewrite) })
  sheet.walkAtRules('import', rule => { rule.params = cssValue(rule.params, rewrite, true) })
  return sheet.toString()
}

function json(source: string, rewrite: Rewrite): string {
  // Validate JSON, then edit only string spans so large numbers and formatting survive.
  JSON.parse(source)
  return javascript('(' + source + ')', rewrite).slice(1, -1)
}

const URL_ATTRIBUTES = new Set(['src', 'href', 'poster', 'data', 'action', 'formaction', 'xlink:href'])
function html(source: string, rewrite: Rewrite, integrity: (url: string, value: string) => string): string {
  const tree = parseHtml(source, { sourceCodeLocationInfo: true })
  const edits: Edit[] = []
  const pending: DefaultTreeAdapterMap['node'][] = [tree]
  while (pending.length) {
    const node = pending.pop()!
    if ('childNodes' in node) pending.push(...node.childNodes)
    if ('content' in node) pending.push(node.content)
    if (!('tagName' in node)) continue
    const location = node.sourceCodeLocation
    if (!location) continue
    for (const attr of node.attrs) {
      let value = attr.value
      if (node.tagName === 'base' && attr.name === 'href' && value === '/') value = rewrite('/index.html').replace(/index\.html$/, '')
      else if (URL_ATTRIBUTES.has(attr.name)) value = rewrite(value)
      else if (attr.name === 'srcset') value = value.replace(/(^|,\s*)(\/[^\s,]+)(?=\s|,|$)/g, (_all, separator, url) => separator + rewrite(url))
      else if (attr.name === 'style') value = cssValue(value, rewrite)
      else if (attr.name.startsWith('on')) value = javascript(value, rewrite)
      else if (attr.name === 'srcdoc') value = html(value, rewrite, integrity)
      else if (attr.name === 'integrity' && ['script', 'link'].includes(node.tagName)) {
        const url = node.attrs.find(a => a.name === (node.tagName === 'script' ? 'src' : 'href'))?.value
        if (url) value = integrity(url, value)
      }
      const range = location.attrs?.[attr.prefix ? attr.prefix + ':' + attr.name : attr.name]
      if (range && value !== attr.value) edits.push({
        start: range.startOffset, end: range.endOffset,
        text: `${attr.prefix ? attr.prefix + ':' : ''}${attr.name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`,
      })
    }
    if (!location.startTag || !location.endTag) continue
    const start = location.startTag.endOffset, end = location.endTag.startOffset
    const before = source.slice(start, end)
    let after = before
    if (node.tagName === 'style') after = css(before, rewrite)
    if (node.tagName === 'script' && !node.attrs.some(a => a.name === 'src')) {
      const type = node.attrs.find(a => a.name === 'type')?.value.toLowerCase() ?? ''
      if (['', 'module', 'text/javascript', 'application/javascript'].includes(type)) after = javascript(before, rewrite)
      else if (['application/json', 'importmap'].includes(type)) after = json(before, rewrite)
    }
    if (before !== after) edits.push({ start, end, text: after })
  }
  return applyEdits(source, edits)
}

/** Scope bundled root URLs to the authorized launch. Never mutate cached artifact bytes. */
export function gameAssetResponse(artifact: GameArtifact, filePath: string, launchRoot: string): Buffer<ArrayBuffer> {
  if (!/^\/(?:play|preview)\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9.-]+\/$/.test(launchRoot))
    throw new Error('Invalid game launch root')
  const file = artifact.files.find(file => file.path === filePath)
  if (!file) throw new Error('Asset missing')
  const bytes = Buffer.from(file.data, 'base64')
  const extension = filePath.split('.').at(-1)!.toLowerCase()
  if (!['html', 'js', 'mjs', 'css', 'json', 'gltf', 'svg'].includes(extension)) return bytes
  const paths = new Set(artifact.files.map(file => '/' + file.path))
  const directories = new Set<string>()
  for (const file of artifact.files) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add('/' + parts.slice(0, i).join('/') + '/')
  }
  let changed = false
  const rewrite: Rewrite = value => {
    if (!value.startsWith('/') || value.startsWith('//') || value.startsWith(launchRoot)) return value
    const pathname = value.split(/[?#]/, 1)[0]
    let decoded: string
    try { decoded = decodeURIComponent(pathname) } catch { return value }
    if (decoded.split('/').some(part => part === '..' || part === '.')) return value
    if (!paths.has(decoded) && ![...directories].some(dir => decoded.startsWith(dir))) return value
    changed = true
    return launchRoot + value.slice(1)
  }
  const source = bytes.toString('utf8')
  let result: string
  if (extension === 'js' || extension === 'mjs') result = javascript(source, rewrite)
  else if (extension === 'css') result = css(source, rewrite)
  else if (extension === 'json' || extension === 'gltf') result = json(source, rewrite)
  else result = html(source, rewrite, (url, integrity) => {
    const resolved = new URL(rewrite(url), 'https://game.invalid' + launchRoot + filePath)
    if (resolved.origin !== 'https://game.invalid' || !resolved.pathname.startsWith(launchRoot)) return integrity
    const target = decodeURIComponent(resolved.pathname.slice(launchRoot.length))
    // Only script/style integrity is rewritten; other resources and external hosts retain theirs.
    if (!/\.(?:m?js|css)$/i.test(target) || !artifact.files.some(f => f.path === target)) return integrity
    const body = gameAssetResponse(artifact, target, launchRoot)
    if (body.equals(Buffer.from(artifact.files.find(f => f.path === target)!.data, 'base64'))) return integrity
    const updated = integrity.replace(/\b(sha256|sha384|sha512)-[a-zA-Z0-9+/=]+/g,
      (_value, algorithm: string) => `${algorithm}-${createHash(algorithm).update(body).digest('base64')}`)
    if (updated !== integrity) changed = true
    return updated
  })
  return changed ? Buffer.from(result) : bytes
}
