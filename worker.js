export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        success: true,
        message: "Lagos Hustle backend is working!"
      });
    }

    return new Response(
      "Lagos Hustle backend is running!",
      {
        headers: {
          "Content-Type": "text/plain"
        }
      }
    );
  }
};
