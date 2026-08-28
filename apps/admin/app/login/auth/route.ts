export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD?.trim() || "ailyn-stage1";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isHttps = forwardedProto === "https" || new URL(request.url).protocol === "https:";
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
      "Set-Cookie": `ailyn_admin=ok; HttpOnly; SameSite=Lax; Path=/; ${isHttps ? "Secure;" : ""}`
    }
  });
}
