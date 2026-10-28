# Upstream

This panel is based on **shadcn-admin** by Sat Naing — https://github.com/satnaing/shadcn-admin
(MIT, see `LICENSE` in this folder).

- Source commit: `e16c87f213a5ba5e45964e9b67c792105ec74d26` (main, 2026-06-11,
  "build(deps): bump @clerk/react from 6.4.2 to 6.4.3 (#303)"; `v2.2.1-77-ge16c87f`)
- Imported with `git archive` into `hub/web/` on 2026-10-29.

## Kept

Layout system (collapsible sidebar, `SidebarRail`, header, `Main`), command palette (⌘K / Ctrl+K,
cmdk), theme provider + switch (dark by default), layout provider, the `components/ui/*` shadcn
primitives that are used, the data-table toolbar / faceted filter / column header / view options /
pagination, `ConfirmDialog`, `PasswordInput`, navigation progress bar, skip link, sign-in page
layout, 404/500 pages, TanStack Router (file routes) + TanStack Query + TanStack Table, recharts,
sonner, react-hook-form + zod.

## Removed

Clerk auth and its routes, the mock auth store (zustand), axios, faker data and every demo feature
(dashboard demo, tasks, users, apps, chats, settings, help center, sign-up, forgot-password, OTP,
2-column sign-in, error showcase pages), team switcher, profile dropdown, top nav, config drawer,
font provider + Google Fonts (Inter is self-hosted via `@fontsource-variable/inter`), direction
(RTL) provider, input-otp, react-day-picker/calendar/date-picker, avatar, radio-group, checkbox,
bulk actions, vitest/playwright tests, knip, devtools, Netlify config, brand icons.

## Changed

- Turkish UI strings; ekip routes (`/`, `/projeler`, `/isler`, `/isler/$id`, `/calistirmalar`,
  `/havuzlar`, `/paneller`, `/login`).
- `vite.config.ts`: build to `../public` (served by `hub/src/server.js`), no inlined assets, and a
  small plugin that strips runtime `<style>` injection from sonner, react-style-singleton and Radix
  Select/ScrollArea so the hub can keep `style-src 'self'`; the equivalent rules live in
  `src/styles/index.css` and `sonner/dist/styles.css` is imported as a file.
- `CommandDialog` renders its (sr-only) title inside the dialog content for Radix a11y.

## Updating

Diff a newer upstream checkout against the commit above and port what is useful by hand; this is a
fork, not a vendored copy.
