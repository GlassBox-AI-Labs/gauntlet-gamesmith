# vendor/

Third-party source the app ships as-is.

## img2threejs

The Asset Build hands every cast entry to a sculptor that runs the
[`img2threejs`](https://github.com/img2threejs/img2threejs) skill. The skill has
to be real files on disk — the sculptor shells out to `forge/state.py` and
`forge/next.py` with Python — so it is vendored here, packaged as an
`extraResources` entry, and copied into the app's Claude harness home on the
first Asset Build of each run.

It is vendored rather than cloned on demand because a missing skill used to fail
silently: the sculptor could not run `forge/`, so it hand-wrote models shaped to
look like the skill's output and nothing downstream could tell.
See `docs/ASSET-PHASE.md`.

`img2threejs.json` records which upstream commit is in the tree. To move to a
newer one, re-vendor the tracked files at that commit and update the stamp:

    git clone https://github.com/img2threejs/img2threejs.git /tmp/i2t
    git -C /tmp/i2t checkout <tag>
    rm -rf vendor/img2threejs && mkdir -p vendor/img2threejs
    git -C /tmp/i2t archive HEAD | tar -x -C vendor/img2threejs

`git archive` is what keeps the copy clean: tracked files only, no `.git`, no
`__pycache__`. Do not hand-edit anything under `img2threejs/` — the whole point
is that it mirrors upstream.
