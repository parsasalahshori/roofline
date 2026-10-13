# Exact Ironclad visual reference

Source: https://roofing-os-demo.vercel.app/ (Ironclad OS demo), inspected October 12, 2026. This is the live application shown in the owner's video. Screenshots are design reference material with synthetic demo data, not Roofline company data or operational metrics.

Reconstruct the layout, scale, typography, color, density, interactions and responsive behavior. Preserve Roofline's identity, real data, complete features, accessible controls and backend contracts. Do not turn the reference screenshots into a static application background or import the demo's synthetic business figures.

## Captures

- Desktop at **1440 x 900 CSS pixels**, device pixel ratio 1: `desktop`, `front-desk`, `pipeline`, `measure`, `schedule`, `storm`, `agents`, `claims` JPEGs.
- Phone breakpoint at **390 x 844 CSS pixels**: desktop and Front Desk JPEGs.
- `desktop-metrics.json` and `front-desk-metrics.json` are read-only computed-style measurements taken from the live DOM at desktop size. Read them along with images; do not infer CSS dimensions from an image resized in a chat.

## Measured visual system

- Archivo Variable is the reference font; body 14px / 1.45, text graphite `#151c22`. Use a properly licensed font package or existing approved local font; preserve a usable fallback. Wide bold display headings have a different visual character from plain system Arial.
- Desktop header **34px tall**, 13px type, background `rgba(246,247,248,.82)` with 22px backdrop blur. Keep functional menu, search, company switch and account access.
- Map fills the working desktop beneath the header. Desktop widgets begin at **x20 / y50**, with **372px** left column and **360px** right column aligned 20px from the right edge. The center remains visibly map-based rather than filling the screen with dashboard cards.
- Desktop widgets have 20px padding, 20px radius, near-white `rgba(246,247,248,.97)`, subtle 1px outline and soft shadow. Gap 12px. Normal card labels 13px; greeting 27px / 1.1 bold; revenue uses a strong large display figure.
- Dock at desktop: 576px x 70px, centered, 12px from bottom, 22px radius, 12px horizontal padding, 10px gaps. App targets are 50px squares with 14px corner radius, distinctive colored tiles, white line icons and small relevant count badges. Preserve all existing app entry points and access restrictions.
- Front Desk desktop window: **x20 / y42 / width1400 / height766** at 1440x900. Radius18px, neutral near-white `#f6f7f8`. The window heading is **16px**, not an oversized page headline. Close/minimize targets32px, buttons roughly36px high, filters28px. Restore focus correctly on close and support Escape.
- Front Desk top stats are compact and aligned. Inbox column is approximately369px with 70px rows; the selected conversation fills the remaining width with summary, recording/transcript and working actions. A large empty right region is not an acceptable normal state. Auto-select only where safe for read-marking semantics; otherwise use an intentional helpful empty state.
- Colored accents express app identity and actionable state. Avoid the old blanket warm beige/yellow styling, thick card borders, huge headings or generic dense sidebar dashboard.
- On phone, cards flow in one column and feature panels use available width with reachable navigation and scroll. Do not shrink the desktop to make it fit. Retain touch targets, input visibility, and keyboard/screen reader behavior.

## Acceptance

Compare Roofline and reference at matching CSS viewport dimensions. Keep important actions working through the existing API hooks and approval/send gates. Use actual exposed data or a truthful empty/loading/error state. Review each changed screen at desktop and phone sizes. The screenshots were captured without running reference provider actions; no screenshots constitute functional evidence for Roofline.
