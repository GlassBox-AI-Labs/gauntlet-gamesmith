# Run form prototype

Variant A (quiet composer) is the selected direction. Preserve its compact pace control,
expandable run options, model overrides, and connected-agent pills while iterating.
B and C remain comparison snapshots until the selected design is integrated into production.

Run `pnpm prototype:app` from the repository root for a separate Electron instance.
It uses port 5176 (or CONDUCTOR_PORT), separate build outputs, and a temporary user-data
profile. It never opens the production ledger or starts/authenticates agents. Close its
window to quit. `pnpm prototype:run-form` remains the browser-only preview.

The composer accepts file/folder drops. Files are retained as browser File objects in
memory; images open the reusable ImageLightbox. Folder chips use opaque session IDs
and validated main-process Finder actions. The browser-only preview supports files and
image previews; native folders require the Electron instance. No folder contents are
traversed. Closing/reloading discards context; Create run previews the simulated plan.

The goal and recent runs are sample data. Attachments start empty so all previews refer
to actual files selected by the operator. This is still a UI prototype, not the production
run submission or attachment-ingestion pipeline.

The selected design is now integrated into the real run flow. Run `pnpm dev:run-form`
for its separate persistent Electron profile on port 5177. The commands above remain
throwaway comparison previews; see the desktop README for real attachment storage.
