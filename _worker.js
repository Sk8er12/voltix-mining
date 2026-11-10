
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API status
    if (url.pathname === "/api/status") {
      return Response.json({
        status: "online",
        project: "VOLTIX",
        database: !!env.DB,
        version: "1.0.0"
      });
    }

    // API health check
    if (url.pathname === "/api/health") {
      return Response.json({
        status: "healthy",
        service: "VOLTIX Mining API"
      });
    }

    // Serve website files
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("VOLTIX Mining is online", {
      status: 200,
      headers: {
        "Content-Type": "text/plain"
      }
    });
  }
};
