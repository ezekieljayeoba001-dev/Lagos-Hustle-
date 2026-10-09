export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        success: true,
        message: "Lagos Hustle backend is working"
      });
    }

    if (url.pathname === "/api/db-test") {
      try {
        const result = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).all();

        return Response.json({
          success: true,
          tables: result.results
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: "Database binding is not configured yet"
        }, { status: 500 });
      }
    }

    return new Response("Lagos Hustle backend is running!");
  }
};
