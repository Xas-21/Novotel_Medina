(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.NovotelRoutes = api;
})(typeof window !== "undefined" ? window : null, function () {
  const SECTIONS = { duty: 1, night: 1, guest: 1 };
  const VIEWS = { today: 1, archive: 1, analysis: 1 };

  function pathFor(section, view) {
    if (view === "users") return "/users";
    if (view === "settings") return "/settings";
    if (section === "full") return "/dashboard";
    return "/" + section + "/" + view;
  }

  function parsePath(path) {
    const parts = String(path || "/").split("/").filter(Boolean);
    if (!parts.length || parts[0] === "dashboard") return { section: "full", view: "today" };
    if (parts[0] === "users") return { section: "full", view: "users" };
    if (parts[0] === "settings") return { section: "full", view: "settings" };
    if (!SECTIONS[parts[0]] || !VIEWS[parts[1] || "today"]) return { section: "full", view: "today" };
    return { section: parts[0], view: parts[1] || "today" };
  }

  function allowRoute(route, role) {
    if ((route.view === "users" || route.view === "settings") && role !== "admin") {
      return { section: "full", view: "today" };
    }
    if (role === "guest" && route.section !== "guest" && route.section !== "full") {
      return { section: "guest", view: "today" };
    }
    return { section: route.section, view: route.view };
  }

  return { pathFor, parsePath, allowRoute };
});
