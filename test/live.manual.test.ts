import { describe, expect, it } from "vitest"
import { PublicKey, type NetworkId } from "o1js"
import { Bridge, type Config } from "../src/index"

type BridgeNetworkId = Extract<NetworkId, "testnet" | "mainnet">

const networkIds = ["testnet", "mainnet"] as const satisfies readonly BridgeNetworkId[]

const readNetworkId = (key: string, fallback: BridgeNetworkId): BridgeNetworkId => {
	const value = process.env[key]?.trim() || fallback
	if (networkIds.includes(value as BridgeNetworkId)) return value as BridgeNetworkId
	throw new Error(`${key} must be one of: ${networkIds.join(", ")}`)
}

const l1Network = readNetworkId("BRIDGE_SDK_L1_NETWORK", "testnet")
const l2Network = readNetworkId("BRIDGE_SDK_L2_NETWORK", "testnet")

const defaultL1Url = (network: BridgeNetworkId): string =>
	network === "mainnet"
		? "https://gateway.mina.mainnet.zeko.io"
		: "https://gateway.mina.devnet.zeko.io"

const defaultL1ArchiveUrl = (network: BridgeNetworkId): string =>
	network === "mainnet"
		? "https://gateway.mina.archive.mainnet.zeko.io"
		: "https://gateway.mina.archive.devnet.zeko.io"

const defaultL2Url = (network: BridgeNetworkId): string =>
	network === "mainnet" ? "https://mainnet.zeko.io/graphql" : "https://testnet.zeko.io/graphql"

const defaultL2ArchiveUrl = (network: BridgeNetworkId): string =>
	network === "mainnet"
		? "https://archive.mainnet.zeko.io/graphql"
		: "https://archive.testnet.zeko.io/graphql"

const defaultActionsApiUrl = (network: BridgeNetworkId): string =>
	network === "mainnet"
		? "https://api.actions.zeko.io/graphql"
		: "https://testnet.api.actions.zeko.io/graphql"

const liveConfig: Config = {
	l1Url: process.env.BRIDGE_SDK_L1_URL?.trim() || defaultL1Url(l1Network),
	l1ArchiveUrl: process.env.BRIDGE_SDK_L1_ARCHIVE_URL?.trim() || defaultL1ArchiveUrl(l1Network),
	zekoUrl: process.env.BRIDGE_SDK_L2_URL?.trim() || defaultL2Url(l2Network),
	zekoArchiveUrl: process.env.BRIDGE_SDK_L2_ARCHIVE_URL?.trim() || defaultL2ArchiveUrl(l2Network),
	actionsApi: process.env.BRIDGE_SDK_ACTIONS_API_URL?.trim() || defaultActionsApiUrl(l2Network),
	l1Network,
	l2Network
}

const walletAddress =
	process.env.BRIDGE_SDK_WALLET_ADDRESS?.trim() ||
	"B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF"

describe("bridge-sdk live", () => {
	it("keeps live read-only deposit state APIs aligned", async () => {
		const bridge = await Bridge.init(liveConfig)
		const recipient = PublicKey.fromBase58(walletAddress)

		const [depositsWithStates, canFinalizeDeposit, canCancelDeposit] = await Promise.all([
			bridge.fetchDepositsWithStates(recipient),
			bridge.canFinalizeDeposit(recipient),
			bridge.canCancelDeposit(recipient)
		])

		expect(Array.isArray(depositsWithStates.deposits)).toBe(true)
		expect(typeof depositsWithStates.syncedIndex).toBe("number")
		expect(typeof depositsWithStates.acceptedIndex).toBe("number")
		expect(typeof depositsWithStates.confirmedIndex).toBe("number")
		expect(typeof depositsWithStates.finalisedIndex).toBe("number")
		expect(typeof depositsWithStates.cancelledIndex).toBe("number")
		expect(typeof canFinalizeDeposit.available).toBe("boolean")
		expect(
			canFinalizeDeposit.reason === null || typeof canFinalizeDeposit.reason === "string"
		).toBe(true)
		expect(typeof canCancelDeposit.available).toBe("boolean")
		expect(canCancelDeposit.reason === null || typeof canCancelDeposit.reason === "string").toBe(
			true
		)

		for (const deposit of depositsWithStates.deposits) {
			expect(typeof deposit.cancellable).toBe("boolean")
			expect(typeof deposit.cancelled).toBe("boolean")
			expect(typeof deposit.finalised).toBe("boolean")

			if (deposit.cancelled || deposit.finalised) {
				expect(deposit.cancellable).toBe(false)
			}
		}

		expect(canCancelDeposit.available).toBe(
			depositsWithStates.deposits.some((deposit) => deposit.cancellable)
		)
	}, 30_000)
})
