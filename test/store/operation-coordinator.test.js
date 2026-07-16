import assert from "node:assert/strict";
import test from "node:test";
import { OperationCoordinator } from "../../server/store/OperationCoordinator.js";

test("写操作串行执行且嵌套版本操作不会死锁", async () => {
  const coordinator = new OperationCoordinator();
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const operations = Array.from({ length: 12 }, (_, index) => coordinator.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push("start-" + index);
    if (index === 4) {
      await coordinator.run(async () => {
        order.push("nested-" + index);
      }, "嵌套操作");
    }
    await new Promise((resolve) => setTimeout(resolve, 3));
    order.push("end-" + index);
    active -= 1;
  }, "操作 " + index));

  await Promise.all(operations);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order.slice(0, 3), ["start-0", "end-0", "start-1"]);
  assert.ok(order.indexOf("nested-4") > order.indexOf("start-4"));
  assert.ok(order.indexOf("nested-4") < order.indexOf("end-4"));
  assert.deepEqual(coordinator.status(), { active: null, waiting: 0 });
});
