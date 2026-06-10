import { afterEach, describe, expect, it, vi } from "vitest"
import { pollProvingResult } from "../src/prover"
import type { BridgeRuntime } from "../src/runtime"

const buildRuntime = ({
	verbose,
	provingResult = JSON.stringify({ executed: "txn-hash" })
}: {
	verbose: boolean
	provingResult?: string
}): BridgeRuntime =>
	({
		config: {
			verbose,
			pollTimeout: 1,
			l1Url: "http://l1.test",
			l1ArchiveUrl: "http://l1-archive.test",
			zekoUrl: "http://l2.test",
			zekoArchiveUrl: "http://l2-archive.test",
			l1Network: "testnet",
			l2Network: "testnet",
			actionsApi: "http://actions.test"
		},
		l2Client: () => ({
			query: vi.fn().mockResolvedValue({
				data: {
					provingResult
				}
			})
		})
	}) as unknown as BridgeRuntime

afterEach(() => {
	vi.restoreAllMocks()
})

describe("pollProvingResult", () => {
	it("does not write debug logs when the runtime is not verbose", async () => {
		const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined)

		await expect(pollProvingResult(buildRuntime({ verbose: false }), "proof-key", 0)).resolves.toBe(
			"txn-hash"
		)

		expect(consoleDebug).not.toHaveBeenCalled()
	})

	it("reports invalid proving result JSON with context", async () => {
		await expect(
			pollProvingResult(buildRuntime({ verbose: false, provingResult: "not-json" }), "proof-key", 0)
		).rejects.toThrow("Invalid proving result JSON for key proof-key")
	})

	it("reports unsupported proving result payloads with context", async () => {
		await expect(
			pollProvingResult(
				buildRuntime({ verbose: false, provingResult: JSON.stringify({ status: "unknown" }) }),
				"proof-key",
				0
			)
		).rejects.toThrow("Unsupported proving result payload for key proof-key")
	})
})
