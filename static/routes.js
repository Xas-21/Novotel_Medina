(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.NovotelRoutes = api;
})(typeof window !== "undefined" ? window : null, function () {
  const REPORT_VIEWS = { today: 1, archive: 1, analysis: 1 };
  const SECTIONS = { duty: REPORT_VIEWS, night: REPORT_VIEWS, guest: REPORT_VIEWS, parking: { manage: 1, logs: 1 } };
  const FIRST_VIEW = { parking: "manage" };
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
    const views = SECTIONS[parts[0]];
    const view = parts[1] || FIRST_VIEW[parts[0]] || "today";
    if (!views || !views[view]) return { section: "full", view: "today" };
    return { section: parts[0], view: view };
  }

  function allowRoute(route, role) {
    if ((route.view === "users" || route.view === "settings") && role !== "admin") {
      return { section: "full", view: "today" };
    }
    if (role === "parking" && route.section !== "parking" && route.section !== "full") {
      return { section: "parking", view: "manage" };
    }
    if (role === "guest" && route.section !== "guest" && route.section !== "parking" && route.section !== "full") {
      return { section: "guest", view: "today" };
    }
    return { section: route.section, view: route.view };
  }

  return { pathFor, parsePath, allowRoute };
});
