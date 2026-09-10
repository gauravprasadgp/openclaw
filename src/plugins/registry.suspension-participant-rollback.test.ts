/** Verifies plugin-registered suspension participants follow the active registry. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectGatewaySuspensionParticipants,
  prepareGatewaySuspensionParticipants,
  resumeGatewaySuspensionParticipants,
} from "../infra/gateway-suspension-participants.js";
import { resetGatewaySuspensionParticipantsForTest } from "../infra/gateway-suspension-participants.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  commitStagedPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createQueuePlugin(activeCount: number) {
  const fixture = createPluginRegistryFixture();
  const record = createPluginRecord({ id: "queue-plugin", name: "Queue Plugin" });
  const status = vi.fn(() => ({ activeCount }));
  let unregister = () => {};
  let registerAgain = () => {};
  registerTestPlugin({
    ...fixture,
    record,
    register(api) {
      registerAgain = () => {
        api.registerGatewaySuspensionParticipant({
          id: "late",
          prepare: () => ({ activeCount: 0 }),
          status,
          resume: () => {},
        });
      };
      unregister = api.registerGatewaySuspensionParticipant({
        id: "delivery-queue",
        prepare: () => ({ activeCount }),
        status,
        resume: () => {},
      });
    },
  });
  return { ...fixture, record, status, unregister, registerAgain };
}

function expectQueueCount(...counts: number[]) {
  expect(inspectGatewaySuspensionParticipants()).toEqual(
    counts.map((count) => ({
      participantId: "queue-plugin:delivery-queue",
      count,
      message: expect.any(String),
    })),
  );
}

afterEach(() => {
  resumeGatewaySuspensionParticipants();
  resetPluginRuntimeStateForTest();
  resetGatewaySuspensionParticipantsForTest();
});

describe("gateway suspension participant plugin lifecycle", () => {
  it("publishes only the active registry and restores it after candidate rollback", () => {
    const active = createQueuePlugin(3);
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
    setActivePluginRegistry(active.registry.registry);
    const snapshot = captureActivePluginRegistrySnapshot();
    const candidate = createQueuePlugin(7);

    expectQueueCount(3);
    expect(candidate.status).not.toHaveBeenCalled();
    stageActivePluginRegistry(candidate.registry.registry, null, "default");
    expectQueueCount(3, 7);
    rollbackStagedPluginRegistry(snapshot);
    expectQueueCount(3);

    // A stale unregister handle must not remove the restored instance.
    candidate.unregister();
    expectQueueCount(3);
  });

  it.each(["commit", "rollback"])(
    "can %s a staged registry after suspension fences both generations",
    (transition) => {
      const active = createQueuePlugin(3);
      const candidate = createQueuePlugin(7);
      setActivePluginRegistry(active.registry.registry);
      const snapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(candidate.registry.registry, null, "default");

      // Retained APIs from either live generation must preserve the other's queues.
      active.registerAgain();
      candidate.registerAgain();
      expect(inspectGatewaySuspensionParticipants().map((blocker) => blocker.count)).toEqual([
        3, 3, 7, 7,
      ]);
      prepareGatewaySuspensionParticipants();

      if (transition === "commit") {
        commitStagedPluginRegistry(active.registry.registry, candidate.registry.registry);
      } else {
        rollbackStagedPluginRegistry(snapshot);
      }
      expect(getActivePluginRegistry()).toBe(
        transition === "commit" ? candidate.registry.registry : active.registry.registry,
      );
      // Detached prepared instances still own work until suspension recovery.
      expect(
        inspectGatewaySuspensionParticipants()
          .map((blocker) => blocker.count)
          .toSorted((left, right) => left - right),
      ).toEqual([3, 3, 7, 7]);
      resumeGatewaySuspensionParticipants();
      expect(inspectGatewaySuspensionParticipants().map((blocker) => blocker.count)).toEqual(
        transition === "commit" ? [7, 7] : [3, 3],
      );
    },
  );

  it("drops an active participant when plugin registration rolls back", () => {
    const plugin = createQueuePlugin(3);
    setActivePluginRegistry(plugin.registry.registry);
    expectQueueCount(3);

    plugin.registry.rollbackPluginGlobalSideEffects(plugin.record.id, plugin.record);

    expect(plugin.registerAgain).toThrow(/no longer active/);
    plugin.status.mockClear();
    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
    expect(plugin.status).not.toHaveBeenCalled();
  });

  it("preserves a healthy participant when an unrelated plugin rolls back", () => {
    const plugin = createQueuePlugin(2);
    setActivePluginRegistry(plugin.registry.registry);
    plugin.registry.rollbackPluginGlobalSideEffects("other-plugin");
    expectQueueCount(2);
  });

  it("removes retired registry callbacks when a successor has no participants", () => {
    const plugin = createQueuePlugin(2);
    setActivePluginRegistry(plugin.registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(plugin.registerAgain).toThrow(/no longer active/);

    expect(inspectGatewaySuspensionParticipants()).toEqual([]);
    expect(plugin.status).not.toHaveBeenCalled();
  });

  it("rejects candidate activation during a suspension without changing the active registry", () => {
    const active = createQueuePlugin(3);
    const candidate = createQueuePlugin(7);
    setActivePluginRegistry(active.registry.registry);
    prepareGatewaySuspensionParticipants();

    expect(() => setActivePluginRegistry(candidate.registry.registry)).toThrow();

    expect(getActivePluginRegistry()).toBe(active.registry.registry);
    expectQueueCount(3);
    expect(candidate.status).not.toHaveBeenCalled();
  });
});
