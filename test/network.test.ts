import { Mina, PublicKey } from "o1js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setL2 } from "../src/network"
import type { BridgeRuntime } from "../src/runtime"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("network selection", () => {
	it("configures the L2 network with the archive endpoint", async () => {
		const fetchSpy = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: { actions: [] } })
		}))
		vi.stubGlobal("fetch", fetchSpy)

		setL2({
			config: {
				l1Url: "http://l1.test",
				l1ArchiveUrl: "http://l1-archive.test",
				zekoUrl: "http://l2.test",
				zekoArchiveUrl: "http://l2-archive.test",
				l1Network: "testnet",
				l2Network: "testnet",
				actionsApi: "http://actions.test"
			}
		} as BridgeRuntime)

		await Mina.activeInstance.fetchActions(
			PublicKey.fromBase58("B62qkekmS9273D1EsFfMSJMMDAmgvh1WyoYE2vs1r7k4GtGBqVYABn2")
		)

		expect(fetchSpy).toHaveBeenCalledWith("http://l2-archive.test", expect.anything())
	})
})
