export default function LoginPage({ searchParams }: Readonly<{ searchParams?: { error?: string } }>) {
  return (
    <main className="loginShell">
      <section className="loginPanel">
        <p className="eyebrow">Ailyn Stage 1</p>
        <h1>Admin login</h1>
        {searchParams?.error ? <p className="errorText">Password is incorrect.</p> : null}
        <form className="stack" action="/login/auth" method="post">
          <input name="password" type="password" placeholder="Password" autoComplete="current-password" />
          <button type="submit">Enter</button>
        </form>
      </section>
    </main>
  );
}
