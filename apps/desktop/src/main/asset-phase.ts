import fs from 'node:fs'
import path from 'node:path'

/**
 * The parts of the Asset Build that touch disk.
 *
 * A worker sculpts one cast entry with the `img2threejs` skill, which takes one
 * object per image. The Reference Pack holds whole scenes, so the crop below is
 * the seam between them: it is the only new tool the phase needs, and like the
 * engine gate it is rewritten into the workspace every round rather than left
 * for a worker to edit.
 */

/** One thing worth sculpting, as the Reference Study recorded it. */
export interface CastEntry {
  /** Stable slug; becomes `src/assets/<name>.ts`. */
  name: string
  kind: string
  /** Frames the object is visible in, best first. */
  stills: string[]
  /** Where in the frame it is — "the white dog, front left". */
  locator: string
  /** What it does in play: what it collides with, what attaches to it. */
  role: string
  priority: number
}

/**
 * Where a worker keeps everything about one asset: the crop it cut, the skill's
 * state file, the spec, and the render it was judged against. Outside `src/` so
 * the engine gate never walks it, and outside the Reference Pack because that
 * is frozen.
 */
export function assetWorkDir(name: string): string {
  return path.posix.join('.img2threejs', name)
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Read the cast out of the pack manifest.
 *
 * `cast.md` is the prose a worker reads; the manifest is what the app parses,
 * the same split the pack already uses for its sources. Malformed entries are
 * dropped rather than thrown on: a half-written cast should cost the entries it
 * broke, not the whole phase, and `scanReferencePack` reports the shortfall.
 */
export function parseCast(manifestJson: string | null): CastEntry[] {
  if (!manifestJson?.trim()) return []
  let value: unknown
  try {
    value = JSON.parse(manifestJson)
  } catch {
    return []
  }
  const raw = (value as { cast?: unknown }).cast
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const cast: CastEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    // The name becomes a file path and a work directory, so anything that is
    // not a plain slug is rejected here rather than sanitised into something
    // the worker did not ask for.
    if (!SLUG.test(name) || seen.has(name)) continue
    const stills = Array.isArray(entry.stills) ? entry.stills.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []
    seen.add(name)
    cast.push({
      name,
      kind: typeof entry.kind === 'string' ? entry.kind : 'prop',
      stills,
      locator: typeof entry.locator === 'string' ? entry.locator : '',
      role: typeof entry.role === 'string' ? entry.role : '',
      priority: Number.isFinite(entry.priority) ? Number(entry.priority) : 100,
    })
  }
  // Lowest priority number first, so a run that runs out of budget has spent it
  // on the things the Reference Study said mattered most.
  return cast.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
}

/**
 * Cast slugs the critic blamed the model itself for, deduped.
 *
 * A verdict written before the asset phase carries no targets at all, which
 * reads here as "nothing to re-sculpt" and sends every finding to the
 * implementer — exactly what those runs already did.
 */
export function assetTargets(findings: { target?: string }[]): string[] {
  const names = findings
    .map((finding) => finding.target?.trim() ?? '')
    .filter((target) => target.startsWith('asset:'))
    .map((target) => target.slice('asset:'.length).trim())
    .filter(Boolean)
  return [...new Set(names)]
}

/** Cast entries with no factory yet — what a re-entrant round still owes. */
export function unbuiltCast(workspaceDir: string, cast: CastEntry[]): CastEntry[] {
  return cast.filter((entry) => !fs.existsSync(path.join(workspaceDir, 'src/assets', `${entry.name}.ts`)))
}

/**
 * The crop tool. Pure stdlib plus PIL, and deliberately not clever: the
 * judgement is the worker's, and the script only holds it to rules that a model
 * reliably breaks on its own.
 */
export const CROP_SCRIPT = `#!/usr/bin/env python3
"""Cut one object out of a gameplay still so img2threejs will accept it.

The Reference Pack holds whole scenes; img2threejs takes one object per image
and rejects "a scene, not an object reference" at intake. This is the seam.

Three subcommands, meant to be driven by an agent that can see:

  sheet  contact-sheet a folder of stills or a video, so the agent can pick
         which frame holds the object before it crops anything
  grid   overlay a labelled grid on the still, so the agent can name a region
         without having to guess pixel coordinates
  cut    cut that region out, widening it when the object is too small to
         clear the pipeline's 512 px floor
  probe  run the skill's own probe_image.py on the result
"""

from __future__ import annotations

import argparse
import json
import string
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# probe_image.py warns below this on either side; a warning drops the image to
# "conditional" and every downstream pass inherits the doubt.
MIN_SIDE = 512

# How much of the finished crop the object must actually occupy.
#
# This is the check probe_image.py cannot make and the one that matters most.
# Widening a small object's box until it reaches 512 px makes the file pass
# every technical test while turning it back into a scene — the exact thing the
# rubric rejects. 0.25 is the point where a human still reads the frame as
# being *of* the object rather than of the place it is standing in.
MIN_FILL = 0.25


def cell_box(size: tuple[int, int], cols: int, rows: int, spec: str) -> tuple[int, int, int, int]:
    """"B3:D6" -> pixel box. A single cell ("B3") is allowed."""
    width, height = size
    parts = spec.upper().split(':')
    first, last = parts[0], parts[-1]

    def parse(cell: str) -> tuple[int, int]:
        letters = ''.join(c for c in cell if c.isalpha())
        digits = ''.join(c for c in cell if c.isdigit())
        if not letters or not digits:
            raise SystemExit(f'bad cell {cell!r} — want a letter and a number, like B3')
        col = string.ascii_uppercase.index(letters)
        row = int(digits) - 1
        if not (0 <= col < cols and 0 <= row < rows):
            raise SystemExit(f'cell {cell!r} is outside the {cols}x{rows} grid')
        return col, row

    c0, r0 = parse(first)
    c1, r1 = parse(last)
    c0, c1 = min(c0, c1), max(c0, c1)
    r0, r1 = min(r0, r1), max(r0, r1)
    cw, ch = width / cols, height / rows
    return (round(c0 * cw), round(r0 * ch), round((c1 + 1) * cw), round((r1 + 1) * ch))


def grid(args: argparse.Namespace) -> int:
    image = Image.open(args.image).convert('RGB')
    width, height = image.size
    draw = ImageDraw.Draw(image, 'RGBA')
    cw, ch = width / args.cols, height / args.rows
    for c in range(1, args.cols):
        draw.line([(c * cw, 0), (c * cw, height)], fill=(255, 0, 128, 160), width=2)
    for r in range(1, args.rows):
        draw.line([(0, r * ch), (width, r * ch)], fill=(255, 0, 128, 160), width=2)
    for c in range(args.cols):
        for r in range(args.rows):
            label = f'{string.ascii_uppercase[c]}{r + 1}'
            x, y = c * cw + 6, r * ch + 4
            draw.rectangle([x - 3, y - 2, x + 9 * len(label), y + 20], fill=(0, 0, 0, 150))
            draw.text((x, y), label, fill=(255, 255, 0, 255))
    image.save(args.out)
    print(json.dumps({'out': str(args.out), 'source': f'{width}x{height}',
                      'grid': f'{args.cols}x{args.rows}',
                      'cell': f'{round(cw)}x{round(ch)} px'}, indent=2))
    return 0


def cut(args: argparse.Namespace) -> int:
    image = Image.open(args.image).convert('RGB')
    width, height = image.size
    if args.cells:
        x0, y0, x1, y1 = cell_box(image.size, args.cols, args.rows, args.cells)
    elif args.box:
        x0, y0, x1, y1 = (int(v) for v in args.box.split(','))
    else:
        raise SystemExit('need --cells or --box')

    requested = (x1 - x0) * (y1 - y0)
    original_box = (x0, y0, x1, y1)
    notes: list[str] = []

    if args.pad:
        x0, y0 = x0 - args.pad, y0 - args.pad
        x1, y1 = x1 + args.pad, y1 + args.pad
        notes.append(f'padded {args.pad} px on every side')

    # Widen in the ORIGINAL before resorting to upscaling: real pixels beat
    # invented ones, and the still usually has room to give.
    grown = False
    for _ in range(2):
        if x1 - x0 < MIN_SIDE:
            need = MIN_SIDE - (x1 - x0)
            x0, x1, grown = x0 - need // 2 - need % 2, x1 + need // 2, True
        if y1 - y0 < MIN_SIDE:
            need = MIN_SIDE - (y1 - y0)
            y0, y1, grown = y0 - need // 2 - need % 2, y1 + need // 2, True
        # Slide back inside the frame rather than clamping, which would shrink it again.
        if x0 < 0: x1, x0 = x1 - x0, 0
        if y0 < 0: y1, y0 = y1 - y0, 0
        if x1 > width: x0, x1 = max(0, x0 - (x1 - width)), width
        if y1 > height: y0, y1 = max(0, y0 - (y1 - height)), height
    if grown:
        notes.append(f'widened in the source to reach the {MIN_SIDE} px floor')

    crop = image.crop((x0, y0, x1, y1))
    cw, chh = crop.size
    fill = requested / (cw * chh)

    # Widening won the pixel count and lost the picture: the object is now a
    # detail in a scene. Refuse rather than hand the pipeline a crop that
    # passes probe_image and fails the rubric.
    if grown and fill < MIN_FILL and not args.allow_upscale:
        print(json.dumps({
            'ok': False,
            'reason': 'object too small in this still',
            'fillRatio': round(fill, 3),
            'minFill': MIN_FILL,
            'detail': f'reaching {MIN_SIDE} px needed so much surrounding scene that the object '
                      f'is only {fill:.1%} of the frame. That is a scene, not an object reference.',
            'options': [
                'crop the same object from a still where it is larger',
                're-run with --allow-upscale to keep the tight box and invent pixels '
                '(detail will be unreliable; say so in the spec)',
            ],
        }, indent=2))
        return 2

    upscaled = False
    if args.allow_upscale and fill < MIN_FILL:
        # Take the tight box back and scale it up: fewer real pixels, but a
        # picture of the object rather than of its neighbourhood.
        x0, y0, x1, y1 = original_box
        if args.pad:
            x0, y0, x1, y1 = x0 - args.pad, y0 - args.pad, x1 + args.pad, y1 + args.pad
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(width, x1), min(height, y1)
        crop = image.crop((x0, y0, x1, y1))
        cw, chh = crop.size
        fill = 1.0
        # The widening was abandoned, so its note would now be a lie.
        notes = [n for n in notes if 'widened in the source' not in n]
    if min(crop.size) < MIN_SIDE:
        scale = MIN_SIDE / min(crop.size)
        crop = crop.resize((round(crop.size[0] * scale), round(crop.size[1] * scale)), Image.LANCZOS)
        upscaled = True
        notes.append(f'UPSCALED x{scale:.2f} — the still had no more real pixels to give; '
                     f'record detail confidence as low in the spec')

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    crop.save(args.out, quality=95)
    final = crop.size
    report = {
        'ok': True,
        'out': str(args.out),
        'sourceBox': [x0, y0, x1, y1],
        'size': f'{final[0]}x{final[1]}',
        'clearsFloor': min(final) >= MIN_SIDE,
        'upscaled': upscaled,
        # How much of the crop is the thing you asked for. Low means the object
        # is swimming in scenery, which is the rubric's "not an object reference".
        'fillRatio': round(fill, 3),
        'notes': notes,
    }
    print(json.dumps(report, indent=2))
    return 0


def sheet(args: argparse.Namespace) -> int:
    """One picture of every candidate, so choosing a frame costs one look."""
    source = Path(args.source)
    if source.is_dir():
        files = sorted(f for f in source.iterdir()
                       if f.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'})
        if not files:
            raise SystemExit(f'no images in {source}')
        thumbs = []
        for f in files[: args.limit]:
            im = Image.open(f).convert('RGB')
            im.thumbnail((args.thumb, args.thumb))
            thumbs.append((f.name, im))
    else:
        # A video: sample it evenly rather than reading every frame.
        out_dir = Path(args.out).parent / '_frames'
        out_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', str(source), '-vf',
             f'fps=1/{args.every},scale={args.thumb}:-1', '-y',
             str(out_dir / 'f-%03d.png')], check=True)
        files = sorted(out_dir.glob('f-*.png'))[: args.limit]
        thumbs = [(f.name, Image.open(f).convert('RGB')) for f in files]

    cols = args.cols
    rows = (len(thumbs) + cols - 1) // cols
    cw = max(im.width for _, im in thumbs)
    ch = max(im.height for _, im in thumbs)
    out = Image.new('RGB', (cols * cw, rows * ch), (12, 12, 12))
    draw = ImageDraw.Draw(out)
    for i, (name, im) in enumerate(thumbs):
        x, y = (i % cols) * cw, (i // cols) * ch
        out.paste(im, (x, y))
        draw.rectangle([x + 2, y + 2, x + 9 * len(name) + 10, y + 22], fill=(0, 0, 0))
        draw.text((x + 6, y + 6), name, fill=(255, 255, 0))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out)
    print(json.dumps({'out': str(args.out), 'tiles': len(thumbs),
                      'grid': f'{cols}x{rows}'}, indent=2))
    return 0


def probe(args: argparse.Namespace) -> int:
    script = Path(args.skill) / 'forge/stage1_intake/probe_image.py'
    if not script.exists():
        raise SystemExit(f'no probe_image.py under {args.skill}')
    return subprocess.call([sys.executable, str(script), str(args.image)])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)

    g = sub.add_parser('grid', help='overlay a labelled grid for the agent to aim with')
    g.add_argument('image', type=Path)
    g.add_argument('--out', type=Path, required=True)
    g.add_argument('--cols', type=int, default=12)
    g.add_argument('--rows', type=int, default=8)
    g.set_defaults(func=grid)

    c = sub.add_parser('cut', help='cut the object out')
    c.add_argument('image', type=Path)
    c.add_argument('--out', type=Path, required=True)
    c.add_argument('--cells', help='grid range, e.g. B3:D6')
    c.add_argument('--box', help='pixel box x0,y0,x1,y1')
    c.add_argument('--pad', type=int, default=0)
    c.add_argument('--allow-upscale', action='store_true',
                   help='object is small in every still: keep the tight box and invent pixels')
    c.add_argument('--cols', type=int, default=12)
    c.add_argument('--rows', type=int, default=8)
    c.set_defaults(func=cut)

    sh = sub.add_parser('sheet', help='contact sheet of a stills folder or a video')
    sh.add_argument('source', help='a directory of stills, or a video file')
    sh.add_argument('--out', type=Path, required=True)
    sh.add_argument('--cols', type=int, default=5)
    sh.add_argument('--thumb', type=int, default=320)
    sh.add_argument('--limit', type=int, default=30)
    sh.add_argument('--every', type=int, default=15, help='video only: seconds between samples')
    sh.set_defaults(func=sheet)

    p = sub.add_parser('probe', help="run the skill's own probe_image.py")
    p.add_argument('image', type=Path)
    p.add_argument('--skill', default='/Users/john/Library/Application Support/Gauntlet Loop/harnesses/claude/skills/img2threejs')
    p.set_defaults(func=probe)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    raise SystemExit(main())
`

/**
 * Put the crop tool in the workspace. Rewritten every round for the same reason
 * the gate is: a tool a worker can weaken is not a tool.
 */
export function scaffoldAssetTools(workspaceDir: string): boolean {
  const full = path.join(workspaceDir, 'tools/crop.py')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
  if (before === CROP_SCRIPT) return false
  fs.writeFileSync(full, CROP_SCRIPT, { mode: 0o755 })
  return true
}
