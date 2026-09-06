# Catalog and publishing flow screenshots

Captured on macOS from the publishing PR build using real Electron, Chromium, and local Supabase. Desktop captures use a separate seeded saved-round profile. The demonstration account/game is separate from the existing public Pac-Man game. Password fields and one-time connection codes are masked.

Coverage is limited to the catalog and publishing feature; Context Steering and other desktop features are outside this PR. The web studio currently includes both artifact upload and release management.

## 01-web-catalog

Public catalog: browse games without signing in.

![Public catalog: browse games without signing in.](01-web-catalog.png)

## 02-web-game

Game details, publisher attribution, controls, and Play.

![Game details, publisher attribution, controls, and Play.](02-web-game.png)

## 03-web-playing

Play expands to fill the browser window.

![Play expands to fill the browser window.](03-web-playing.png)

## 04-web-fullscreen

Browser fullscreen keeps Back and Restart available.

![Browser fullscreen keeps Back and Restart available.](04-web-fullscreen.png)

## 05-web-publisher

Public publisher profile and its games.

![Public publisher profile and its games.](05-web-publisher.png)

## 06-web-mobile

Catalog on a narrow mobile viewport.

![Catalog on a narrow mobile viewport.](06-web-mobile.png)

## 07-web-sign-in

Publisher studio requires a provisioned Supabase account.

![Publisher studio requires a provisioned Supabase account.](07-web-sign-in.png)

## 08-web-sign-in-error

Invalid credentials produce a recoverable sign-in error.

![Invalid credentials produce a recoverable sign-in error.](08-web-sign-in-error.png)

## 09-web-empty-studio

A new publisher has no games; upload and desktop publishing entry points are explained.

![A new publisher has no games; upload and desktop publishing entry points are explained.](09-web-empty-studio.png)

## 10-app-saved-round

Select a saved round to access Publish.

![Select a saved round to access Publish.](10-app-saved-round.png)

## 11-app-sign-in

Publishing is opt-in and starts with account sign-in.

![Publishing is opt-in and starts with account sign-in.](11-app-sign-in.png)

## 12-app-waiting

Desktop waits for browser approval and offers Cancel sign-in.

![Desktop waits for browser approval and offers Cancel sign-in.](12-app-waiting.png)

## 13-web-connect

Approve the desktop connection after signing in through Supabase.

![Approve the desktop connection after signing in through Supabase.](13-web-connect.png)

## 14-web-connected

One-time session handoff confirms the desktop connection.

![One-time session handoff confirms the desktop connection.](14-web-connected.png)

## 15-app-metadata

Enter listing metadata and the shipping build output folder.

![Enter listing metadata and the shipping build output folder.](15-app-metadata.png)

## 16-app-building

The saved revision is built and uploaded, with progress retained in the run log.

![The saved revision is built and uploaded, with progress retained in the run log.](16-app-building.png)

## 17-app-preview-ready

A successful upload opens a private preview; publication still requires an explicit action.

![A successful upload opens a private preview; publication still requires an explicit action.](17-app-preview-ready.png)

## 18-web-private-preview

Private browser preview of the exact release before publishing.

![Private browser preview of the exact release before publishing.](18-web-private-preview.png)

## 19-app-published

Explicit Publish promotes the release and returns its stable catalog URL.

![Explicit Publish promotes the release and returns its stable catalog URL.](19-app-published.png)

## 20-web-live-studio

The studio shows the live release, preview, public link, and Unpublish.

![The studio shows the live release, preview, public link, and Unpublish.](20-web-live-studio.png)

## 21-web-upload-update

Web artifact upload can prepare a new release for an existing game.

![Web artifact upload can prepare a new release for an existing game.](21-web-upload-update.png)

## 22-web-release-preview

A staged release is previewed before promotion.

![A staged release is previewed before promotion.](22-web-release-preview.png)

## 23-web-updated

Publishing an update keeps the game URL and retains the earlier release.

![Publishing an update keeps the game URL and retains the earlier release.](23-web-updated.png)

## 24-web-rollback

Previewing and promoting an earlier ready release rolls the game back.

![Previewing and promoting an earlier ready release rolls the game back.](24-web-rollback.png)

## 25-web-unpublished

Unpublish removes public access while preserving releases in the studio.

![Unpublish removes public access while preserving releases in the studio.](25-web-unpublished.png)

## 26-web-unavailable

Guests see an unavailable state after unpublication.

![Guests see an unavailable state after unpublication.](26-web-unavailable.png)

## 27-app-signed-out

Publisher sign-out returns the desktop to the opt-in sign-in state.

![Publisher sign-out returns the desktop to the opt-in sign-in state.](27-app-signed-out.png)

## 28-app-cancel-sign-in

Cancel stops the browser handoff and leaves sign-in available to retry.

![Cancel stops the browser handoff and leaves sign-in available to retry.](28-app-cancel-sign-in.png)

