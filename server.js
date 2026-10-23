export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // استقبال تحديثات عدد المستخدمين (POST)
    if (request.method === "POST" && url.pathname === "/update") {
      try {
        const data = await request.json();
        
        // منطق حفظ أو تحديث بيانات المستخدمين النشطين
        
        return new Response(JSON.stringify({ status: "success", message: "Updated successfully" }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ status: "error", message: e.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // فحص حالة السيرفر (GET)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response("Falcon Counter Server is active on Cloudflare Workers!", {
        headers: { "Content-Type": "text/plain" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
