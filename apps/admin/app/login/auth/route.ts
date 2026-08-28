export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD?.trim() || "ailyn-stage1";
  if (password !== expected) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/login?error=1"
      }
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `ailyn_admin=ok; HttpOnly; SameSite=Lax; Path=/; ${process.env.NODE_ENV === "production" ? "Secure;" : ""}`
    }
  });
}
