import { getSearchParamValue } from "../lib/api";

export default async function LoginPage({
  searchParams
}: Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const hasError = Boolean(getSearchParamValue(resolvedSearchParams.error));

  return (
    <main className="loginShell">
      <section className="loginPanel">
        <p className="eyebrow">Ailyn</p>
        <h1>Admin login</h1>
        {hasError ? <p className="errorText">Password is incorrect.</p> : null}
        <form className="stack" action="/login/auth" method="post">
          <input name="password" type="password" placeholder="Password" autoComplete="current-password" />
          <button type="submit">Enter</button>
        </form>
      </section>
    </main>
  );
}
