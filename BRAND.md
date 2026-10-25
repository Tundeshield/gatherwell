# Gatherwell brand & UI system

**Gatherwell** — *A better way to bring church life together.*
Multi-branch Church Operations Platform. The name is provisional.

## Renaming the product
Change the name in three places only:
1. `src/brand.js` (`BRAND` — used by every screen, exports and QR downloads)
2. `index.html` (`<title>`, meta description)
3. `public/manifest.webmanifest`
Then replace the wordmark text in `brand/*.svg`.

## Colour tokens (`tailwind.config.js`)
| Token | Hex | Use |
|---|---|---|
| `brand-700` | #244E43 Forest | Primary buttons, active nav, hero metrics |
| `brand-500` | #477562 Sage | Secondary accents, charts |
| `ivory` / `mist-50` | #F6F7F3 | Page background |
| `ink` | #243447 Navy | Headings, important text |
| `gold-500` | #C69B55 Amber | Restrained highlights only (logo hub, "Soon" tags) |
| `white` | #FFFFFF | Cards and surfaces |
| `mist-200` | #E0E3DB | Borders |
| `mist-400` | #69736E | Secondary text (meets 4.5:1 on white) |

Semantic states use Tailwind `green` (success), `amber` (warning), `red` (error) and `sky` (info).
Never use raw `blue-*` / `slate-*` classes — use `brand-*`, `mist-*`, `ink`.
For non-Tailwind contexts (canvas, html2canvas, inline SVG) use `COLORS` from `src/brand.js`.

## Typography
Inter. Weights: 400 body, 500 labels/nav, 600 headings and figures. Avoid 700+.

## Logo
A central amber node (the church/HQ) with spokes to three connected people/branches, held by an arc — a gathering "well".
- `src/components/Logo.jsx` — `<Logo />` lockup and `<LogoMark />` (props: `size`, `onDark`, `tile`)
- `public/favicon.svg`, `public/icon-maskable.svg` — browser and app icons
- `brand/gatherwell-mark.svg`, `brand/gatherwell-horizontal.svg`, `brand/gatherwell-horizontal-reverse.svg` — reports and marketing
Minimum size: 16px for the mark, 24px tall for the lockup. Don't recolour, rotate or add effects.

## Components (`src/components/ui.jsx`)
`Btn`, `IconBtn`, `Badge` (adds `success`/`warning`/`danger`/`info`/`highlight`), `StatCard` (optional `onClick`, `hint`),
`Card`, `Input`, `Textarea`, `Select`, `Toggle`, `EmptyState` (accepts a lucide icon and `action`), `Spinner`,
plus new `PageHeader` and `Alert`.
