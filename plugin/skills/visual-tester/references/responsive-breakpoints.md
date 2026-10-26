# Responsive breakpoints

Default viewports for visual checks:

| Width | Label | Why |
|---|---|---|
| 375  | mobile  | iPhone-class minimum |
| 768  | tablet  | iPad portrait |
| 1280 | desktop | Common laptop |

For each breakpoint, take a screenshot of every top-level scenario. Inspect for:

- Overflow / horizontal scrollbars (only intentional ones allowed)
- Text truncation that hides meaningful content
- Buttons / inputs that are off-screen or unreachable
- Layout collapse that hides primary actions
- Touch targets ≥ 44×44 CSS px on mobile breakpoint

If the spec specifies different breakpoints, use those instead.
