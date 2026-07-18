# APS Web Tools — Brand Palette

SalfaCorp corporate identity, applied 2026-07-17.

## Accent Colors

| Token | CSS Variable | Hex | Usage |
|-------|-------------|-----|-------|
| Primary | `--color-brand` | `#A32428` | Buttons, links, headers, active states |
| Light | `--color-brand-light` | `#B44E51` | Button hover, secondary CTAs |
| Lighter | `--color-brand-lighter` | `#BE6568` | Tertiary accents |
| Muted | `--color-brand-muted` | `#8D9299` | Borders, subtle dividers |
| Surface | `--color-brand-surface` | `#F6E9E9` | Cards, sidebar, section backgrounds |
| Background | `--color-brand-bg` | `#FEFEFE` | Page background |

## Text

| Element | Color |
|---------|-------|
| Headers | `#A32428` (brand) |
| Body text | `text-gray-800` |
| Muted text | `text-gray-500` / `text-gray-400` |

## Tailwind Classes

Use these classes throughout the app:

```
bg-brand          → #A32428 (primary buttons, selected states)
bg-brand-light    → #B44E51 (hover, secondary)
bg-brand-lighter  → #BE6568 (tertiary)
bg-brand-surface  → #F6E9E9 (cards, sidebar)
bg-brand-bg       → #FEFEFE (page background)
text-brand        → #A32428 (headers, active links)
border-brand-muted/20  → subtle borders
border-brand-muted/30  → input borders
border-brand-light/30  → selected states
```

## Card Pattern

```tsx
className="rounded-lg border border-brand-muted/20 bg-white hover:border-brand-muted/40 hover:shadow-md transition-all"
```

## Status Badges (light theme)

```
Active    → text-yellow-700 bg-yellow-50 border-yellow-200
Reviewed  → text-brand bg-brand/10 border-brand-light/30
Resolved  → text-green-700 bg-green-50 border-green-200
Closed    → text-gray-500 bg-gray-100 border-gray-200
```

## Error Display

```tsx
className="border border-red-200 bg-red-50 text-red-700"
```
