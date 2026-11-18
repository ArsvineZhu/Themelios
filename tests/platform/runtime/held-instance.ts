import { Installation, runtimeSettings } from "@themelios/runtime";

const root = Bun.argv[2];
if (!root) throw new Error("Missing installation root");
const app = {
  id: "test.platform",
  formatId: "test.platform",
  settings: runtimeSettings,
  async provision() {},
  async open() {},
};
const session = await Installation.at(root, app).instance("default").open();
console.log("holder ready");
await Bun.sleep(30_000);
await session.close();
