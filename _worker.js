export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return Response.json({
        status: "online",
        project: "VOLTIX",
        database: !!env.DB
      });
    }

    return Response.json({
      message: "VOLTIX Mining API"
    });
  }
};