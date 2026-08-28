export function GET() {
  return Response.json({
    status: "ok",
    service: "admin",
    checkedAt: new Date().toISOString()
  });
}
