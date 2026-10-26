# Examples — good vs bad

## Login handler

### Bad
```ts
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.query(`SELECT * FROM users WHERE email='${email}'`);
  if (user.password === password) {
    res.json({ ok: true, user });
  } else {
    res.status(500).send('login failed');
  }
});
```
Issues: SQL injection, plain password compare, leaking user record, wrong status code.

### Good
```ts
const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

app.post('/api/login', async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const result = await authService.login(body); // service throws InvalidCredentials
    res.cookie('session', result.token, { httpOnly: true, secure: true, sameSite: 'lax' });
    res.json({ user: result.publicUser });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ errors: e.errors });
    if (e instanceof InvalidCredentialsError) return res.status(401).json({ error: 'invalid_credentials' });
    next(e);
  }
});
```

## Service test

### Good
```ts
test('login throws InvalidCredentials when password mismatches', async () => {
  const repo = { findByEmail: vi.fn().mockResolvedValue({ id: 1, passwordHash: await hash('correct') }) };
  const service = new AuthService(repo, fakeTokenSigner);
  await expect(service.login({ email: 'a@b.c', password: 'wrong' }))
    .rejects.toBeInstanceOf(InvalidCredentialsError);
});
```
