# Examples — good vs bad

## Form: handle async submit

### Bad
```tsx
function LoginForm() {
  const onSubmit = async () => {
    await fetch('/api/login', { method: 'POST', body });
    window.location = '/dashboard';
  };
  return <form onSubmit={onSubmit}>...</form>;
}
```
Issues: no loading state, no error state, no validation, side effect on window.

### Good
```tsx
function LoginForm() {
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: (creds: Creds) => api.login(creds),
    onSuccess: () => navigate('/dashboard'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValid(creds)) return;
    mutation.mutate(creds);
  };

  return (
    <form onSubmit={onSubmit} aria-busy={mutation.isPending}>
      {mutation.isError && (
        <p role="alert" className={styles.error}>
          {mutation.error.message}
        </p>
      )}
      ...
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
```

## Button vs div

### Bad
```tsx
<div onClick={onClick} className={styles.button}>Save</div>
```

### Good
```tsx
<button type="button" onClick={onClick} className={styles.button}>Save</button>
```
