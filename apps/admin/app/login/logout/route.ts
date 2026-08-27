export async function POST(_request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": "ailyn_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    }
  });
}
