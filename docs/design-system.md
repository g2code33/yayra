# FloatBrowse Design System & Component Specification

## 1. Design Philosophy & Glassmorphism Architecture

FloatBrowse uses a unified, cross-platform design system engineered for high-performance rendering on Android (GeckoView / WebView), Windows (WebView2), and Linux (WebKitGTK).

### Core Aesthetic Foundations
- **Canvas Base**: Ultra-deep midnight navy (`#060b19` / `#0a1026`) creating high-contrast depth for translucent UI overlays.
- **Translucent Glass**: Multi-layered backdrop blurs (`backdrop-filter: blur(20px)`), paired with subtle white specular highlights (`rgba(255, 255, 255, 0.12)`) and gradient rims.
- **Accents & Energy**: Vivid Cyan (`#06b6d4` / `#22d3ee`) transitioning into Royal Blue (`#2563eb` / `#3b82f6`) for active interactive elements, focal buttons, and indicator rings.
- **Original Floating Orb**: Distinctive browser glass orb logo avoiding generic AssistiveTouch clones—featuring an inner glowing compass core, navigation ring orbit, and specular refraction curves.

---

## 2. Color System & Semantic Tokens

### Color Palette

| Token Family | Hex / RGBA | Role / Usage |
| :--- | :--- | :--- |
| `navy-950` | `#060b19` | Application dark background, viewport canvas |
| `navy-900` | `#0a1026` | Elevated background layer |
| `navy-850` | `#0d1736` | Card background fill base |
| `navy-700` | `#172554` | Header & toolbar background |
| `cyan-500` | `#06b6d4` | Primary brand accent & active state glow |
| `cyan-400` | `#22d3ee` | Interactive highlight & focus rings |
| `blue-600` | `#2563eb` | Secondary gradient accent & callouts |
| `slate-50` | `#f8fafc` | Primary typography contrast |
| `slate-400` | `#94a3b8` | Secondary typography & icon outlines |
| `glass-fill` | `rgba(17, 31, 72, 0.65)` | Translucent glass surface background |
| `glass-border` | `rgba(255, 255, 255, 0.14)` | Specular frosted edge highlight |

---

## 3. Typography Scale & 4px Spacing Grid

### Spacing Grid
The design system operates on a base 4px spatial rhythm:
- `xs`: 4px
- `sm`: 8px
- `md`: 12px
- `base`: 16px
- `lg`: 24px
- `xl`: 32px
- `2xl`: 48px
- `3xl`: 64px

### Typography Scale
Using fluid system typography (`Inter`, `system-ui`, `-apple-system`, `Segoe UI`, `Roboto`):
- **Display**: `2.5rem` / `1.15` / `800`
- **Heading 1**: `2.0rem` / `1.2` / `700`
- **Heading 2**: `1.5rem` / `1.25` / `700`
- **Heading 3**: `1.25rem` / `1.3` / `600`
- **Heading 4**: `1.125rem` / `1.35` / `600`
- **Body Large**: `1.0rem` / `1.5` / `400`
- **Body (Default)**: `0.875rem` / `1.5` / `400`
- **Body Small**: `0.75rem` / `1.4` / `400`
- **Caption**: `0.6875rem` / `1.3` / `600`

---

## 4. FloatBrowse Glass Orb Logo

The FloatBrowse logo is an original SVG vector orb composed of:
1. **Outer Glass Spherical Body**: Layered radial gradient with translucent refraction rim.
2. **Orbital Navigation Ring**: Rotated elliptical navigation vector with segmented dash rhythm.
3. **Inner Compass Core**: High-luminance neon core with radial cyan glow.
4. **Cardinal Sight Marks**: Precision browser target markers at 0°, 90°, 180°, and 270°.

```html
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="24" r="20" fill="url(#orbGradient)" stroke="url(#orbBorder)" stroke-width="2"/>
  <ellipse cx="24" cy="24" rx="21" ry="8" stroke="url(#ringGradient)" stroke-width="1.5" stroke-dasharray="2 1" transform="rotate(-25 24 24)"/>
  <circle cx="24" cy="24" r="7" fill="url(#coreGradient)" filter="drop-shadow(0 0 6px rgba(6,182,212,0.8))"/>
  <path d="M24 10V14M24 34V38M10 24H14M34 24H38" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
</svg>
```

---

## 5. UI Component Library (14 Required Modules)

1. **Theme**: `ThemeManager` with `dark`, `light`, and `system` auto-switching and CSS variable emission.
2. **Colors**: Comprehensive color scales and dark/light tokens in `@yayra/shared-ui`.
3. **Typography**: Scalable typography variables and utility classes.
4. **Spacing & Radii**: Geometric grid tokens (`Radius.sm` through `Radius.full`).
5. **Icons**: Pure SVG vector library (`logoOrb`, `globe`, `search`, `bookmark`, `history`, `shield`, `pin`, etc.).
6. **GlassCard**: Translucent container supporting standard, elevated, subtle, glowing, and interactive metric stat card variants.
7. **Button**: Interactive action buttons (`primary`, `secondary`, `outline`, `ghost`, `danger`, `icon`, `loading`).
8. **Input**: Glass input controls with search icons, SSL security badges, and clear actions.
9. **Toggle**: Reactive smooth toggle switch with label and description slots.
10. **Dialog**: Modal dialog system with confirm, cancel, custom content slots, and escape key handling.
11. **Loading**: Neon orb spinners, pulsing skeleton cards, and progress bars.
12. **BrowserToolbar**: Omnibox address bar, navigation history triggers (back/forward/reload), bookmark status, tabs strip, and desktop mode switch.
13. **FloatingBubble**: Screen-snapping floating glass orb with pulsing live-status halo and badge count.
14. **WindowControls**: Native titlebar controls supporting Windows (min/max/close), Linux, and macOS traffic lights with Always-on-Top pin toggle.

---

## 6. Main Dashboard Architecture

The Main Dashboard is an integrated single-screen control hub featuring:
- **Brand Hero & Floating Status**: Real-time service state indicator reflecting whether the floating bubble is running or stopped.
- **Quick Launch Controls**: Instant browser launch and quick shortcuts (DuckDuckGo, Wikipedia, GitHub, Hacker News).
- **Navigation Tabs**:
  - `Overview`: Service status, active metrics, search engines, ad blocking summary.
  - `History`: Searchable, filterable browsing history with one-click URL launch and item deletion.
  - `Bookmarks`: Hierarchical bookmark tree with folder support and modal add-dialog.
  - `Downloads`: Sandboxed local download file tracker.
  - `Settings`: Toggle between Circle-first mode vs Browser-first mode, default search engine selection, hardware acceleration, and tracker blocking.
  - `Permissions`: Android system overlay ("Draw over other apps") and foreground service permission verification.
  - `About`: Engine runtime details (GeckoView / WebView2 / WebKitGTK) and build version.

---

## 7. Responsive Platform Adaptations

- **Android (Mobile Portrait & Landscape)**:
  - Touch-friendly minimum target size (44px × 44px).
  - Floating orb bounds snapping to left/right screen edges with screen-edge padding.
  - Bottom-oriented navigation actions in mobile viewports.
- **Windows & Linux (Desktop)**:
  - Renderer-owned main tab/titlebar chrome with pointer/IPC window movement; no native `-webkit-app-region: drag` input grabs in that strip, so tabs and caption buttons remain interactive.
  - Dual desktop floating mode configuration (Circle-first compact orb vs Pinned floating window).
  - Full keyboard shortcuts (`Enter` to submit URL, `Alt+Left`/`Alt+Right` for navigation, `Ctrl+R` reload, `Escape` to dismiss dialogs).
