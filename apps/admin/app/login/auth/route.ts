export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD ?? "ailyn-stage1";
  if (password !== expected) {
    return Response.redirect(new URL("/login?error=1", request.url), 303);
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `ailyn_admin=ok; HttpOnly; SameSite=Lax; Path=/; ${process.env.NODE_ENV === "production" ? "Secure;" : ""}`
    }
  });
}
