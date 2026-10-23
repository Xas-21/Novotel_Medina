const assert = require("node:assert");
const test = require("node:test");
const { parsePath, pathFor, allowRoute } = require("../static/routes.js");

test("each menu page has its own address", () => {
  assert.deepEqual(parsePath("/"), { section: "full", view: "today" });
  assert.deepEqual(parsePath("/dashboard"), { section: "full", view: "today" });
  assert.deepEqual(parsePath("/duty/today"), { section: "duty", view: "today" });
  assert.deepEqual(parsePath("/duty/archive"), { section: "duty", view: "archive" });
  assert.deepEqual(parsePath("/duty/analysis"), { section: "duty", view: "analysis" });
  assert.deepEqual(parsePath("/night/archive"), { section: "night", view: "archive" });
  assert.deepEqual(parsePath("/guest/analysis"), { section: "guest", view: "analysis" });
  assert.deepEqual(parsePath("/users"), { section: "full", view: "users" });
  assert.deepEqual(parsePath("/settings"), { section: "full", view: "settings" });
  assert.equal(pathFor("night", "today"), "/night/today");
  assert.equal(pathFor("full", "today"), "/dashboard");
  assert.equal(pathFor("full", "users"), "/users");
});

test("unknown addresses open the dashboard", () => {
  assert.deepEqual(parsePath("/nope"), { section: "full", view: "today" });
  assert.deepEqual(parsePath("/parking/today"), { section: "full", view: "today" });
  assert.deepEqual(parsePath("/duty/manage"), { section: "full", view: "today" });
});

test("parkings has its own two pages", () => {
  assert.deepEqual(parsePath("/parking"), { section: "parking", view: "manage" });
  assert.deepEqual(parsePath("/parking/manage"), { section: "parking", view: "manage" });
  assert.deepEqual(parsePath("/parking/logs"), { section: "parking", view: "logs" });
  assert.equal(pathFor("parking", "logs"), "/parking/logs");
});

test("parking role sees only the dashboard and Parkings", () => {
  assert.deepEqual(allowRoute({ section: "full", view: "today" }, "parking"), { section: "full", view: "today" });
  assert.deepEqual(allowRoute({ section: "parking", view: "logs" }, "parking"), { section: "parking", view: "logs" });
  assert.deepEqual(allowRoute({ section: "duty", view: "today" }, "parking"), { section: "parking", view: "manage" });
  assert.deepEqual(allowRoute({ section: "guest", view: "archive" }, "parking"), { section: "parking", view: "manage" });
  assert.deepEqual(allowRoute({ section: "full", view: "users" }, "parking"), { section: "full", view: "today" });
});

test("every other role can open Parkings", () => {
  for (const role of ["admin", "staff", "night", "guest"]) {
    assert.deepEqual(allowRoute({ section: "parking", view: "manage" }, role), { section: "parking", view: "manage" });
  }
});

test("roles keep the pages they can already open", () => {
  assert.deepEqual(
    allowRoute({ section: "duty", view: "archive" }, "night"),
    { section: "duty", view: "archive" }
  );
  assert.deepEqual(
    allowRoute({ section: "duty", view: "today" }, "guest"),
    { section: "guest", view: "today" }
  );
  assert.deepEqual(
    allowRoute({ section: "full", view: "users" }, "staff"),
    { section: "full", view: "today" }
  );
  assert.deepEqual(
    allowRoute({ section: "full", view: "settings" }, "admin"),
    { section: "full", view: "settings" }
  );
});
