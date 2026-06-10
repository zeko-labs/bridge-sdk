import { PublicKey, UInt32, UInt64 } from "o1js"
import { describe, expect, it } from "vitest"
import type { GqlClient } from "../src/graphql"
import { Bridge } from "../src/index"
import type { BridgeRuntime } from "../src/runtime"
import type { Config } from "../src/types"

const bridgeConfig: Config = {
	l1Url: "http://l1.test",
	l1ArchiveUrl: "http://l1-archive.test",
	zekoUrl: "http://l2.test",
	zekoArchiveUrl: "http://l2-archive.test",
	l1Network: "testnet",
	l2Network: "testnet",
	actionsApi: "http://actions.test"
}

const buildGraphqlClient = (): GqlClient =>
	Object.assign(
		() =>
			({
				query: async () => ({ data: {} })
			}) as unknown as ReturnType<GqlClient>,
		{ label: "test-client" }
	)

const publicKey = PublicKey.fromBase58("B62qkekmS9273D1EsFfMSJMMDAmgvh1WyoYE2vs1r7k4GtGBqVYABn2")

describe("Bridge constructor", () => {
	it("rejects legacy constructor calls", () => {
		const LegacyBridge = Bridge as unknown as new (...args: unknown[]) => Bridge

		expect(() => new LegacyBridge(bridgeConfig)).toThrow("Invalid Bridge runtime")
	})

	it("accepts direct runtime construction", () => {
		expect(
			() =>
				new Bridge({
					config: bridgeConfig,
					l1Client: buildGraphqlClient(),
					l1ArchiveClient: buildGraphqlClient(),
					l2Client: buildGraphqlClient(),
					l2ArchiveClient: buildGraphqlClient(),
					actionsApiClient: buildGraphqlClient(),
					l1AccountCreationFee: UInt64.from(1),
					l2AccountCreationFee: UInt64.from(1),
					outerPk: publicKey,
					innerPk: publicKey,
					outerHolders: [publicKey],
					innerHolder: publicKey,
					outerTokenOwner: publicKey,
					sequencerPk: publicKey,
					withdrawalDelay: UInt32.from(10),
					bridgeFeeRecipientL1: publicKey,
					bridgeFeeRecipientL2: publicKey,
					bridgeProofFee: UInt64.from(1),
					V2_DEPOSITS_START_INDEX: UInt32.zero,
					V2_WITHDRAWALS_START_INDEX: UInt32.zero
				} satisfies BridgeRuntime)
		).not.toThrow()
	})

	it("rejects the legacy constructor signature", () => {
		const LegacyBridge = Bridge as unknown as new (...args: unknown[]) => Bridge

		expect(
			() =>
				new LegacyBridge(
					bridgeConfig,
					buildGraphqlClient(),
					buildGraphqlClient(),
					buildGraphqlClient(),
					buildGraphqlClient(),
					buildGraphqlClient(),
					UInt64.from(1),
					UInt64.from(1),
					publicKey,
					publicKey,
					[publicKey],
					publicKey,
					publicKey,
					publicKey,
					UInt32.from(10),
					publicKey,
					publicKey,
					UInt64.from(1)
				)
		).toThrow("Invalid Bridge runtime")
	})
})
