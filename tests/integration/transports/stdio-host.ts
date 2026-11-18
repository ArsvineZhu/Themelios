import { standardOperations } from "@themelios/application";
import { createApplicationModule } from "@themelios/application";
import { Installation } from "@themelios/runtime";
import { serveMcpStdio } from "@themelios/transports";

const root = Bun.argv[2];
if (!root) throw new Error("Missing installation root");
const installation = Installation.at(
  root,
  createApplicationModule({
    id: "test.protocols",
    formatId: "test.protocols",
    resourceRoot: root,
    tasks: [],
  }),
);
const session = await installation
  .instance("default")
  .open({ mode: "read-only" });
try {
  const endpoint = await serveMcpStdio(session.api, {
    operations: standardOperations(),
    agentRefs: (app) => ({
      resolveRef: app.materials.resolve,
      formatRef: app.materials.agentRef,
    }),
    principal: { id: "test-reader", permissions: ["read"] },
  });
  await endpoint.closed;
} finally {
  await session.close();
}
