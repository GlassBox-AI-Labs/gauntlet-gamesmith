# Publishing UI review captures

The five account-flow screenshots are from the built desktop React renderer at
app-code commit `d30969e3b37051506cdc08f37ace418c1d4269de`. The ten grid, detail,
editor, and publishing captures were refreshed at app-code commit `514d3821c5edd960bd4282b6ef280bc62a283716`.
Captures use a 1440 × 1050 viewport (full-page images extend to fit content). All
accounts, email codes, games, build history, and cover art are sample fixtures;
IPC/service responses are mocked. These images show actual app components,
not live account operations or evidence of hosted email delivery.

`automatic-menu-cover.png` is the 1280 × 720 output of the real Electron capture
module at the same app-code commit, rendering a local sample game with ES modules,
JSON assets, WebGL2, and the menu-ready signal. The library and detail fixtures
use this captured image. The listing editor shows a separate manually chosen cover.

- [Email-first entry in the compact account form](auth-email.png)
- [Password sign-in or Email me a code](auth-password.png)
- [Signup with email, public publisher name, and password](auth-signup.png)
- [Eight-slot OTP verification with resend countdown](publisher-otp.png)
- [Invalid-code feedback with retry](auth-invalid-code.png)
- [Account-wide library showing published and unpublished games](my-games.png)
- [Whole-card hover including card padding](my-games-hover.png)
- [Full-width game detail with cover, description, controls, and releases](game-manager.png)
- [Separate compact editor for description, controls, and cover](edit-listing.png)
- [Build overview showing Published and Manage game](build-published.png)
- [Exact live round showing Published and Manage game](round-published.png)
- [Another round offers Publish round 1 while round 2 is live](round-other.png)
- [Manage game opens the release-management drawer directly](publishing-manager.png)
- [Compact listing editor within the publishing drawer](publishing-edit.png)
- [Publishing another saved round opens its preview form](publish-round.png)

- [Automatically captured main-menu cover from the sample game](automatic-menu-cover.png)
