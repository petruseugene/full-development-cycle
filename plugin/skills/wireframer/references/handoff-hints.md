# Handoff hints (so frontend-dev can read the wireframes)

When generating mockups, leave hints that the frontend-dev subagent will pick up:

1. **Component boundaries** — wrap likely components in HTML comments:
   ```html
   <!-- component: LoginForm -->
   <form>...</form>
   <!-- /component -->
   ```

2. **State variants** — name files with state suffix: `login-error.html`, `login-loading.html`. The implementer maps these to component states.

3. **Data shape hints** — if a screen shows data, comment the expected shape:
   ```html
   <!-- data: { email: string, name: string }[] -->
   <ul>...</ul>
   ```

4. **Interaction hints** — call out what's clickable and where it goes:
   ```html
   <button><!-- onClick → POST /api/login → /dashboard -->Sign in</button>
   ```
