# A11y checklist (visual + interactive)

## Keyboard
- Every interactive element is reachable via Tab in a logical order.
- Focus is always visible (outline or equivalent indicator).
- Esc closes modals / popovers.
- Enter activates buttons; Space activates buttons that aren't `<button>`.

## Screen reader cues (Playwright snapshot inspection)
- Form fields have `<label>` or `aria-label`.
- Buttons have accessible names.
- Images have `alt` (or `alt=""` if decorative).
- Live regions (`role="alert"` / `aria-live`) present where async errors render.

## Color / contrast
- Body text contrast ≥ 4.5:1 against background.
- Large text (≥18pt regular or ≥14pt bold) ≥ 3:1.
- Don't rely on color alone — error states have an icon or label too.

## Motion / disabled states
- `prefers-reduced-motion` respected for non-essential animations.
- Disabled buttons have visible disabled state and `aria-disabled` or `disabled`.

## Failure severity
- Blocker: keyboard trap, missing label on form input, contrast < 3:1 anywhere
- Warning: visible focus is faint, body text contrast 4.0–4.5
